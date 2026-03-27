import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  FilesystemBackend,
  ReadFileResult,
  StatResult,
  ListDirResult,
  GlobResult,
  GrepResult,
} from "./filesystem-backend";
import {
  FS_MAX_LINE_LENGTH as MAX_LINE_LENGTH,
} from "../config/service-constants";

const execFileAsync = promisify(execFile);
const DEFAULT_ROOT = process.cwd();
const DEFAULT_SAMPLE_BYTES = 8_192;

function truncateLine(text: string) {
  if (text.length <= MAX_LINE_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_LINE_LENGTH)}... (line truncated to ${MAX_LINE_LENGTH} chars)`;
}

export class LocalFilesystemBackend implements FilesystemBackend {
  resolveCwd(cwd?: string) {
    if (!cwd) {
      return DEFAULT_ROOT;
    }
    return path.isAbsolute(cwd) ? cwd : path.resolve(DEFAULT_ROOT, cwd);
  }

  resolvePath(requestedPath: string, cwd: string) {
    return path.isAbsolute(requestedPath)
      ? path.normalize(requestedPath)
      : path.resolve(cwd, requestedPath);
  }

  async readFileOrDir(targetPath: string): Promise<ReadFileResult> {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      const dirents = await fs.readdir(targetPath, { withFileTypes: true });
      const entries = dirents
        .map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      return { type: "directory", entries };
    }
    if (await this.isProbablyBinary(targetPath)) {
      throw new Error(`Cannot read binary file: ${targetPath}`);
    }
    const content = await fs.readFile(targetPath, "utf8");
    return { type: "file", content };
  }

  async writeFile(targetPath: string, content: string, append: boolean) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    if (append) {
      await fs.appendFile(targetPath, content, "utf8");
    } else {
      await fs.writeFile(targetPath, content, "utf8");
    }
    const stat = await fs.stat(targetPath);
    return { sizeBytes: stat.size };
  }

  async stat(targetPath: string): Promise<StatResult | null> {
    try {
      const stat = await fs.stat(targetPath);
      return {
        type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
        sizeBytes: Number(stat.size),
        modifiedAt: stat.mtime.toISOString(),
        createdAt: stat.birthtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  async statOrThrow(targetPath: string): Promise<StatResult> {
    const result = await this.stat(targetPath);
    if (!result) {
      const suggestions = await this.getPathSuggestions(targetPath);
      if (suggestions.length > 0) {
        throw new Error(`Path not found: ${targetPath}\nDid you mean:\n${suggestions.join("\n")}`);
      }
      throw new Error(`Path not found: ${targetPath}`);
    }
    return result;
  }

  async listDir(targetPath: string, recursive: boolean, limit: number): Promise<ListDirResult> {
    if (!recursive) {
      const dirents = await fs.readdir(targetPath, { withFileTypes: true });
      const entries = dirents
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
        .sort((left, right) => left.localeCompare(right));
      return {
        entries: entries.slice(0, limit),
        totalEntries: dirents.length,
        truncated: dirents.length > limit,
      };
    }

    const entries: string[] = [];
    const walk = async (currentPath: string, prefix = ""): Promise<void> => {
      if (entries.length >= limit) {
        return;
      }
      const dirents = await fs.readdir(currentPath, { withFileTypes: true });
      dirents.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of dirents) {
        if (entries.length >= limit) {
          return;
        }
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const rendered = `${relative}${entry.isDirectory() ? "/" : ""}`;
        entries.push(rendered);
        if (entry.isDirectory()) {
          await walk(path.join(currentPath, entry.name), relative);
        }
      }
    };

    await walk(targetPath);
    const truncated = entries.length >= limit;
    return {
      entries,
      totalEntries: truncated ? null : entries.length,
      truncated,
    };
  }

  async glob(targetPath: string, pattern: string, limit: number): Promise<GlobResult> {
    const glob = new Bun.Glob(pattern);
    const matches: string[] = [];
    for await (const match of glob.scan({ cwd: targetPath, absolute: true, onlyFiles: false })) {
      matches.push(match);
      if (matches.length >= limit) {
        break;
      }
    }
    matches.sort((left, right) => left.localeCompare(right));
    return {
      matches,
      truncated: matches.length >= limit,
    };
  }

  async grep(
    searchRoot: string,
    pattern: string,
    include: string | undefined,
    limit: number,
    literal: boolean,
    caseSensitive: boolean,
  ): Promise<GrepResult> {
    const args = ["-nH", "--hidden", "--no-messages", "--color=never"];
    if (literal) {
      args.push("-F");
    }
    if (!caseSensitive) {
      args.push("-i");
    }
    if (include) {
      args.push("--glob", include);
    }
    args.push(pattern, searchRoot);

    try {
      const { stdout, stderr } = await execFileAsync("rg", args, {
        cwd: searchRoot,
        maxBuffer: 1024 * 1024 * 4,
      });
      const lines = stdout.trim() ? stdout.trim().split(/\r?\n/) : [];
      if (lines.length === 0) {
        return { matches: [], totalMatchCount: 0, truncated: false };
      }
      const sliced = lines.slice(0, limit);
      const matches = sliced.map((line) => {
        const firstSeparator = line.indexOf(":");
        const secondSeparator = line.indexOf(":", firstSeparator + 1);
        if (firstSeparator === -1 || secondSeparator === -1) {
          return { path: "", lineNumber: 0, text: line };
        }
        return {
          path: line.slice(0, firstSeparator),
          lineNumber: Number.parseInt(line.slice(firstSeparator + 1, secondSeparator), 10),
          text: truncateLine(line.slice(secondSeparator + 1)),
        };
      });
      return {
        matches,
        totalMatchCount: lines.length,
        truncated: lines.length > limit,
      };
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & {
        code?: string | number;
        stdout?: string;
        stderr?: string;
      };
      if (String(execError.code ?? "") === "1") {
        return { matches: [], totalMatchCount: 0, truncated: false };
      }
      if (execError.code === "ENOENT") {
        throw new Error("ripgrep (rg) is required for grep but is not installed.");
      }
      throw new Error(execError.stderr?.trim() || execError.message || "grep failed");
    }
  }

  async mkdir(targetPath: string, recursive: boolean) {
    await fs.mkdir(targetPath, { recursive });
  }

  async movePath(source: string, destination: string) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
  }

  async copyPath(source: string, destination: string, recursive: boolean) {
    const stat = await fs.stat(source);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (stat.isDirectory()) {
      if (!recursive) {
        throw new Error(`Source path is a directory. Set recursive=true to copy it: ${source}`);
      }
      await fs.cp(source, destination, { recursive: true });
    } else {
      await fs.copyFile(source, destination);
    }
  }

  async deletePath(targetPath: string, recursive: boolean) {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory() && !recursive) {
      throw new Error(`Path is a directory. Set recursive=true to delete it: ${targetPath}`);
    }
    await fs.rm(targetPath, { recursive, force: false });
  }

  async isProbablyBinary(filePath: string): Promise<boolean> {
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(DEFAULT_SAMPLE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, DEFAULT_SAMPLE_BYTES, 0);
      if (bytesRead === 0) {
        return false;
      }

      let suspiciousBytes = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        const value = buffer[index] ?? 0;
        if (value === 0) {
          return true;
        }
        if (value < 7 || (value > 14 && value < 32)) {
          suspiciousBytes += 1;
        }
      }

      return suspiciousBytes / bytesRead > 0.3;
    } finally {
      await handle.close();
    }
  }

  async getPathSuggestions(targetPath: string): Promise<string[]> {
    const parent = path.dirname(targetPath);
    const basename = path.basename(targetPath).toLowerCase();
    try {
      const entries = await fs.readdir(parent);
      return entries
        .filter((entry) => {
          const candidate = entry.toLowerCase();
          return candidate.includes(basename) || basename.includes(candidate);
        })
        .slice(0, 5)
        .map((entry) => path.join(parent, entry));
    } catch {
      return [];
    }
  }
}
