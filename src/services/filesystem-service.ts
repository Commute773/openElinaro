import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AccessControlService } from "./access-control-service";
import {
  applyStructuredUpdate,
  buildAddedFileContent,
  parseStructuredPatch,
} from "./structured-patch";
import { telemetry } from "./telemetry";

const execFileAsync = promisify(execFile);
const DEFAULT_ROOT = process.cwd();
const DEFAULT_READ_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_GLOB_LIMIT = 200;
const DEFAULT_GREP_LIMIT = 100;
const MAX_LINE_LENGTH = 2_000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_READ_BYTES_LABEL = `${MAX_READ_BYTES / 1024} KB`;
const DEFAULT_SAMPLE_BYTES = 8_192;
const filesystemTelemetry = telemetry.child({ component: "filesystem" });

type ResolvedPathInput = {
  path?: string;
  filePath?: string;
  cwd?: string;
};

type ToolOutputFormat = "text" | "json";

type ReadParams = ResolvedPathInput & {
  offset?: number;
  limit?: number;
};

type WriteParams = ResolvedPathInput & {
  content: string;
  append?: boolean;
};

type EditParams = ResolvedPathInput & {
  oldString?: string;
  old_string?: string;
  newString?: string;
  new_string?: string;
  replaceAll?: boolean;
};

type MultiEditParams = ResolvedPathInput & {
  edits: Array<{
    oldString?: string;
    old_string?: string;
    newString?: string;
    new_string?: string;
    replaceAll?: boolean;
  }>;
};

type PatchParams = {
  patchText: string;
  cwd?: string;
};

type ListDirParams = ResolvedPathInput & {
  recursive?: boolean;
  limit?: number;
  format?: ToolOutputFormat;
};

type GlobParams = ResolvedPathInput & {
  pattern: string;
  limit?: number;
};

type GrepParams = ResolvedPathInput & {
  pattern: string;
  include?: string;
  limit?: number;
  literal?: boolean;
  caseSensitive?: boolean;
};

type StatParams = ResolvedPathInput & {
  format?: ToolOutputFormat;
};

type MkdirParams = ResolvedPathInput & {
  recursive?: boolean;
};

type CopyMoveParams = {
  source?: string;
  src?: string;
  destination?: string;
  dst?: string;
  cwd?: string;
  recursive?: boolean;
};

type DeleteParams = ResolvedPathInput & {
  recursive?: boolean;
};

function resolveCwd(cwd?: string) {
  if (!cwd) {
    return DEFAULT_ROOT;
  }
  return path.isAbsolute(cwd) ? cwd : path.resolve(DEFAULT_ROOT, cwd);
}

function getRequestedPath(input: ResolvedPathInput) {
  return input.path ?? input.filePath;
}

function resolveToolPath(input: ResolvedPathInput) {
  const requestedPath = getRequestedPath(input);
  if (!requestedPath) {
    throw new Error("path is required");
  }
  const cwd = resolveCwd(input.cwd);
  const resolved = path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(cwd, requestedPath);
  return { cwd, requestedPath, resolved };
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeLineEndings(text: string) {
  return text.replaceAll("\r\n", "\n");
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n") {
  if (ending === "\n") {
    return text;
  }
  return text.replaceAll("\n", "\r\n");
}

function splitFileLines(text: string) {
  if (text.length === 0) {
    return [] as string[];
  }
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function truncateLine(text: string) {
  if (text.length <= MAX_LINE_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_LINE_LENGTH)}... (line truncated to ${MAX_LINE_LENGTH} chars)`;
}

async function statSafe(targetPath: string) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

async function getPathSuggestions(targetPath: string) {
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
    return [] as string[];
  }
}

async function throwPathNotFound(targetPath: string, label = "Path") {
  const suggestions = await getPathSuggestions(targetPath);
  if (suggestions.length > 0) {
    throw new Error(`${label} not found: ${targetPath}\nDid you mean:\n${suggestions.join("\n")}`);
  }
  throw new Error(`${label} not found: ${targetPath}`);
}

async function isProbablyBinary(filePath: string) {
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

function formatDirectoryEntries(entries: string[], offset: number, limit: number, resolvedPath: string) {
  const start = offset - 1;
  const sliced = entries.slice(start, start + limit);
  const numbered = sliced.map((entry, index) => `${start + index + 1}: ${entry}`);
  const lastEntry = start + sliced.length;
  const hasMore = lastEntry < entries.length;

  return [
    `Path: ${resolvedPath}`,
    "Type: directory",
    "Entries:",
    numbered.length > 0 ? numbered.join("\n") : "(empty directory)",
    hasMore
      ? `(Showing entries ${offset}-${lastEntry} of ${entries.length}. Use offset=${lastEntry + 1} to continue.)`
      : `(End of directory - total ${entries.length} entries)`,
  ].join("\n");
}

function buildListDirResult(params: {
  resolvedPath: string;
  entries: string[];
  limit: number;
  recursive: boolean;
  totalEntries: number | null;
  truncated: boolean;
  format?: ToolOutputFormat;
}) {
  const { resolvedPath, entries, limit, recursive, totalEntries, truncated, format } = params;
  if (format === "json") {
    return {
      path: resolvedPath,
      type: "directory" as const,
      recursive,
      limit,
      entries,
      displayedCount: entries.length,
      totalEntries,
      truncated,
    };
  }

  return [
    `Path: ${resolvedPath}`,
    "Type: directory",
    recursive ? "Recursive: yes" : "Recursive: no",
    "Entries:",
    entries.length > 0 ? entries.join("\n") : "(empty directory)",
    truncated
      ? totalEntries === null
        ? `(Results truncated at ${limit} entries.)`
        : `(Results truncated: showing ${entries.length} of ${totalEntries} entries.)`
      : totalEntries === null
        ? `(Total ${entries.length} entries)`
        : `(Total ${totalEntries} entries)`,
  ].join("\n");
}

function buildStatPathResult(params: {
  resolvedPath: string;
  type: "directory" | "file" | "other";
  sizeBytes: number | bigint;
  modifiedAt: string;
  createdAt: string;
  format?: ToolOutputFormat;
}) {
  const result = {
    path: params.resolvedPath,
    type: params.type,
    sizeBytes: Number(params.sizeBytes),
    modifiedAt: params.modifiedAt,
    createdAt: params.createdAt,
  };

  if (params.format === "json") {
    return result;
  }

  return [
    `Path: ${result.path}`,
    `Type: ${result.type}`,
    `Size: ${result.sizeBytes} bytes`,
    `Modified: ${result.modifiedAt}`,
    `Created: ${result.createdAt}`,
  ].join("\n");
}

function normalizeEditStrings(edit: {
  oldString?: string;
  old_string?: string;
  newString?: string;
  new_string?: string;
}) {
  const oldString = edit.oldString ?? edit.old_string;
  const newString = edit.newString ?? edit.new_string;
  if (oldString === undefined) {
    throw new Error("oldString is required");
  }
  if (newString === undefined) {
    throw new Error("newString is required");
  }
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.");
  }
  return { oldString, newString };
}

function applyOneEdit(
  content: string,
  edit: {
    oldString?: string;
    old_string?: string;
    newString?: string;
    new_string?: string;
    replaceAll?: boolean;
  },
  filePath: string,
  editIndex?: number,
) {
  const { oldString, newString } = normalizeEditStrings(edit);
  const label = editIndex === undefined ? "edit" : `edit ${editIndex + 1}`;

  if (oldString.length === 0) {
    return {
      content: newString + content,
      replacements: 1,
      message: `${label}: inserted content at the start of the file.`,
    };
  }

  let matchCount = 0;
  let startIndex = content.indexOf(oldString);
  while (startIndex !== -1) {
    matchCount += 1;
    startIndex = content.indexOf(oldString, startIndex + oldString.length);
  }

  if (matchCount === 0) {
    throw new Error(`${label}: oldString was not found in ${filePath}`);
  }

  if (!edit.replaceAll && matchCount > 1) {
    throw new Error(
      `${label}: oldString matched ${matchCount} occurrences in ${filePath}. Provide a more specific oldString or set replaceAll=true.`,
    );
  }

  const replacements = edit.replaceAll ? matchCount : 1;
  const nextContent = edit.replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);

  return {
    content: nextContent,
    replacements,
    message: `${label}: replaced ${replacements} occurrence${replacements === 1 ? "" : "s"}.`,
  };
}

async function ensurePathExists(targetPath: string, label = "Path"): Promise<Awaited<ReturnType<typeof fs.stat>>> {
  const stat = await statSafe(targetPath);
  if (!stat) {
    const suggestions = await getPathSuggestions(targetPath);
    if (suggestions.length > 0) {
      throw new Error(`${label} not found: ${targetPath}\nDid you mean:\n${suggestions.join("\n")}`);
    }
    throw new Error(`${label} not found: ${targetPath}`);
  }
  return stat;
}

function traceSpan<T>(
  operation: string,
  fn: () => Promise<T>,
  options?: { attributes?: Record<string, unknown> },
) {
  return filesystemTelemetry.span(operation, options?.attributes ?? {}, fn);
}

export class FilesystemService {
  constructor(private readonly access?: AccessControlService) {}

  private authorizePath(targetPath: string) {
    return this.access ? this.access.assertPathAccess(targetPath) : targetPath;
  }

  async read(params: ReadParams) {
    return traceSpan(
      "tool.read_file",
      async () => {
        const offset = params.offset ?? 1;
        const limit = params.limit ?? DEFAULT_READ_LIMIT;
        if (offset < 1) {
          throw new Error("offset must be greater than or equal to 1");
        }
        if (limit < 1) {
          throw new Error("limit must be greater than or equal to 1");
        }

        const { resolved } = resolveToolPath(params);
        this.authorizePath(resolved);
        const stat = await ensurePathExists(resolved, "Path");

        if (stat.isDirectory()) {
          const dirents = await fs.readdir(resolved, { withFileTypes: true });
          const entries = dirents
            .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
            .sort((left, right) => left.localeCompare(right));
          if (entries.length > 0 && offset > entries.length) {
            throw new Error(`Offset ${offset} is out of range for this directory (${entries.length} entries)`);
          }
          return formatDirectoryEntries(entries, offset, limit, resolved);
        }

        if (await isProbablyBinary(resolved)) {
          throw new Error(`Cannot read binary file: ${resolved}`);
        }

        const text = await fs.readFile(resolved, "utf8");
        const lines = splitFileLines(text);
        if (offset > lines.length && !(lines.length === 0 && offset === 1)) {
          throw new Error(`Offset ${offset} is out of range for this file (${lines.length} lines)`);
        }

        const selected: string[] = [];
        let bytes = 0;
        let hasMoreLines = false;
        let truncatedByBytes = false;
        for (let index = offset - 1; index < lines.length; index += 1) {
          if (selected.length >= limit) {
            hasMoreLines = true;
            break;
          }
          const line = truncateLine(lines[index] ?? "");
          const lineWithNumber = `${index + 1}: ${line}`;
          const size = Buffer.byteLength(lineWithNumber, "utf8") + (selected.length > 0 ? 1 : 0);
          if (bytes + size > MAX_READ_BYTES) {
            truncatedByBytes = true;
            hasMoreLines = true;
            break;
          }
          selected.push(lineWithNumber);
          bytes += size;
        }

        const lastLine = offset + selected.length - 1;
        const nextOffset = lastLine + 1;
        const contentLine =
          selected.length > 0 ? selected.join("\n") : "(empty file)";
        const footer = truncatedByBytes
          ? `(Output capped at ${MAX_READ_BYTES_LABEL}. Showing lines ${offset}-${lastLine}. Use offset=${nextOffset} to continue.)`
          : hasMoreLines
            ? `(Showing lines ${offset}-${lastLine} of ${lines.length}. Use offset=${nextOffset} to continue.)`
            : `(End of file - total ${lines.length} lines)`;

        return [
          `Path: ${resolved}`,
          "Type: file",
          "Content:",
          contentLine,
          footer,
        ].join("\n");
      },
      {
        attributes: {
          path: getRequestedPath(params),
          offset: params.offset,
          limit: params.limit,
        },
      },
    );
  }

  async write(params: WriteParams) {
    return traceSpan(
      "tool.write_file",
      async () => {
        const { resolved } = resolveToolPath(params);
        this.authorizePath(resolved);
        const existing = await statSafe(resolved);
        if (existing?.isDirectory()) {
          throw new Error(`Path is a directory, not a file: ${resolved}`);
        }
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        if (params.append) {
          await fs.appendFile(resolved, params.content, "utf8");
        } else {
          await fs.writeFile(resolved, params.content, "utf8");
        }
        const stat = await fs.stat(resolved);
        return `${params.append ? "Appended" : "Wrote"} ${Buffer.byteLength(params.content, "utf8")} bytes to ${resolved}. File size is now ${stat.size} bytes.`;
      },
      {
        attributes: {
          path: getRequestedPath(params),
          append: params.append === true,
          contentLength: params.content.length,
        },
      },
    );
  }

  async edit(params: EditParams) {
    return traceSpan(
      "tool.edit_file",
      async () => {
        const { resolved } = resolveToolPath(params);
        this.authorizePath(resolved);
        const stat = await ensurePathExists(resolved, "File");
        if (stat.isDirectory()) {
          throw new Error(`Path is a directory, not a file: ${resolved}`);
        }

        const originalContent = await fs.readFile(resolved, "utf8");
        const ending = detectLineEnding(originalContent);
        const next = normalizeEditStrings(params);
        const oldString = convertToLineEnding(normalizeLineEndings(next.oldString), ending);
        const newString = convertToLineEnding(normalizeLineEndings(next.newString), ending);
        const result = applyOneEdit(
          originalContent,
          { oldString, newString, replaceAll: params.replaceAll },
          resolved,
        );
        await fs.writeFile(resolved, result.content, "utf8");
        return `Edit applied successfully to ${resolved}. ${result.message}`;
      },
      {
        attributes: {
          path: getRequestedPath(params),
          replaceAll: params.replaceAll === true,
        },
      },
    );
  }

  async multiEdit(params: MultiEditParams) {
    return traceSpan(
      "tool.multi_edit",
      async () => {
        const { resolved } = resolveToolPath(params);
        this.authorizePath(resolved);
        const stat = await ensurePathExists(resolved, "File");
        if (stat.isDirectory()) {
          throw new Error(`Path is a directory, not a file: ${resolved}`);
        }
        if (params.edits.length === 0) {
          throw new Error("edits must contain at least one edit");
        }

        const originalContent = await fs.readFile(resolved, "utf8");
        const ending = detectLineEnding(originalContent);
        let content = originalContent;
        const summaries: string[] = [];
        for (const [index, edit] of params.edits.entries()) {
          const normalized = normalizeEditStrings(edit);
          const oldString = convertToLineEnding(normalizeLineEndings(normalized.oldString), ending);
          const newString = convertToLineEnding(normalizeLineEndings(normalized.newString), ending);
          const result = applyOneEdit(
            content,
            { oldString, newString, replaceAll: edit.replaceAll },
            resolved,
            index,
          );
          content = result.content;
          summaries.push(result.message);
        }

        await fs.writeFile(resolved, content, "utf8");
        return `Applied ${params.edits.length} edits to ${resolved}.\n${summaries.join("\n")}`;
      },
      {
        attributes: {
          path: getRequestedPath(params),
          editCount: params.edits.length,
        },
      },
    );
  }

  async applyPatch(params: PatchParams) {
    return traceSpan(
      "tool.apply_patch",
      async () => {
        const operations = parseStructuredPatch(params.patchText);
        const summaries: string[] = [];

        for (const operation of operations) {
          const resolvedPath = resolveToolPath({ path: operation.path, cwd: params.cwd }).resolved;
          this.authorizePath(resolvedPath);

          if (operation.type === "add") {
            const existing = await statSafe(resolvedPath);
            if (existing) {
              throw new Error(`Add File target already exists: ${resolvedPath}`);
            }
            await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
            await fs.writeFile(resolvedPath, buildAddedFileContent(operation.lines), "utf8");
            summaries.push(`A ${resolvedPath}`);
            continue;
          }

          const current = await ensurePathExists(resolvedPath, "File");
          if (current.isDirectory()) {
            throw new Error(`Path is a directory, not a file: ${resolvedPath}`);
          }

          if (operation.type === "delete") {
            await fs.rm(resolvedPath, { force: false });
            summaries.push(`D ${resolvedPath}`);
            continue;
          }

          const originalContent = await fs.readFile(resolvedPath, "utf8");
          const ending = detectLineEnding(originalContent);
          const nextContent = convertToLineEnding(
            applyStructuredUpdate(originalContent, operation.chunks),
            ending,
          );
          const moveTarget = operation.moveTo
            ? resolveToolPath({ path: operation.moveTo, cwd: params.cwd }).resolved
            : undefined;
          if (moveTarget) {
            this.authorizePath(moveTarget);
          }

          if (moveTarget && moveTarget !== resolvedPath) {
            const existingTarget = await statSafe(moveTarget);
            if (existingTarget) {
              throw new Error(`Move target already exists: ${moveTarget}`);
            }
            await fs.mkdir(path.dirname(moveTarget), { recursive: true });
            await fs.writeFile(moveTarget, nextContent, "utf8");
            await fs.rm(resolvedPath, { force: false });
            summaries.push(`M ${resolvedPath} -> ${moveTarget}`);
            continue;
          }

          await fs.writeFile(resolvedPath, nextContent, "utf8");
          summaries.push(`M ${resolvedPath}`);
        }

        return [
          "Patch applied successfully.",
          ...summaries,
        ].join("\n");
      },
      {
        attributes: {
          cwd: params.cwd,
          patchLength: params.patchText.length,
        },
      },
    );
  }

  async listDir(params: ListDirParams) {
    return traceSpan(
      "tool.list_dir",
      async () => {
        const limit = params.limit ?? DEFAULT_LIST_LIMIT;
        if (limit < 1) {
          throw new Error("limit must be greater than or equal to 1");
        }

        const { resolved } = resolveToolPath({ ...params, path: params.path ?? "." });
        this.authorizePath(resolved);
        const stat = await ensurePathExists(resolved, "Path");
        if (!stat.isDirectory()) {
          throw new Error(`Path is not a directory: ${resolved}`);
        }

        if (!params.recursive) {
          const dirents = await fs.readdir(resolved, { withFileTypes: true });
          const entries = dirents
            .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
            .sort((left, right) => left.localeCompare(right))
            .slice(0, limit);
          return buildListDirResult({
            resolvedPath: resolved,
            entries,
            limit,
            recursive: false,
            totalEntries: dirents.length,
            truncated: dirents.length > limit,
            format: params.format,
          });
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

        await walk(resolved);
        const truncated = entries.length >= limit;
        return buildListDirResult({
          resolvedPath: resolved,
          entries,
          limit,
          recursive: true,
          totalEntries: truncated ? null : entries.length,
          truncated,
          format: params.format,
        });
      },
      {
        attributes: {
          path: getRequestedPath(params) ?? ".",
          recursive: params.recursive === true,
          limit: params.limit,
        },
      },
    );
  }

  async glob(params: GlobParams) {
    return traceSpan(
      "tool.glob",
      async () => {
        const limit = params.limit ?? DEFAULT_GLOB_LIMIT;
        if (limit < 1) {
          throw new Error("limit must be greater than or equal to 1");
        }
        const { resolved } = resolveToolPath({ ...params, path: params.path ?? "." });
        this.authorizePath(resolved);
        const stat = await ensurePathExists(resolved, "Path");
        if (!stat.isDirectory()) {
          throw new Error(`Path is not a directory: ${resolved}`);
        }

        const glob = new Bun.Glob(params.pattern);
        const matches: string[] = [];
        for await (const match of glob.scan({ cwd: resolved, absolute: true, onlyFiles: false })) {
          matches.push(match);
          if (matches.length >= limit) {
            break;
          }
        }
        matches.sort((left, right) => left.localeCompare(right));
        if (matches.length === 0) {
          return `No paths matched pattern ${params.pattern} under ${resolved}.`;
        }
        return [
          `Pattern: ${params.pattern}`,
          `Path: ${resolved}`,
          "Matches:",
          matches.join("\n"),
          matches.length >= limit ? `(Results truncated at ${limit} matches.)` : `(Total ${matches.length} matches)`,
        ].join("\n");
      },
      {
        attributes: {
          pattern: params.pattern,
          path: getRequestedPath(params) ?? ".",
          limit: params.limit,
        },
      },
    );
  }

  async grep(params: GrepParams) {
    return traceSpan(
      "tool.grep",
      async () => {
        const limit = params.limit ?? DEFAULT_GREP_LIMIT;
        if (limit < 1) {
          throw new Error("limit must be greater than or equal to 1");
        }
        const { resolved } = resolveToolPath({ ...params, path: params.path ?? "." });
        this.authorizePath(resolved);
        const stat = await ensurePathExists(resolved, "Path");
        const searchRoot = stat.isDirectory() ? resolved : path.dirname(resolved);
        const include = !stat.isDirectory()
          ? path.basename(resolved)
          : params.include;

        const args = ["-nH", "--hidden", "--no-messages", "--color=never"];
        if (params.literal) {
          args.push("-F");
        }
        if (!params.caseSensitive) {
          args.push("-i");
        }
        if (include) {
          args.push("--glob", include);
        }
        args.push(params.pattern, searchRoot);

        try {
          const { stdout, stderr } = await execFileAsync("rg", args, {
            cwd: searchRoot,
            maxBuffer: 1024 * 1024 * 4,
          });
          const lines = stdout.trim() ? stdout.trim().split(/\r?\n/) : [];
          if (lines.length === 0) {
            return `No matches found for pattern ${params.pattern}.`;
          }
          const sliced = lines.slice(0, limit);
          const output = sliced
            .map((line) => {
              const firstSeparator = line.indexOf(":");
              const secondSeparator = line.indexOf(":", firstSeparator + 1);
              if (firstSeparator === -1 || secondSeparator === -1) {
                return line;
              }
              const filePath = line.slice(0, firstSeparator);
              const lineNumber = line.slice(firstSeparator + 1, secondSeparator);
              const text = truncateLine(line.slice(secondSeparator + 1));
              return `${filePath}:${lineNumber}: ${text}`;
            })
            .join("\n");
          return [
            `Pattern: ${params.pattern}`,
            `Path: ${resolved}`,
            "Matches:",
            output,
            lines.length > limit ? `(Results truncated: showing ${limit} of ${lines.length} matches.)` : `(Total ${lines.length} matches)`,
            stderr.trim() ? `Notes:\n${stderr.trim()}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        } catch (error) {
          const execError = error as NodeJS.ErrnoException & {
            code?: string | number;
            stdout?: string;
            stderr?: string;
          };
          if (String(execError.code ?? "") === "1") {
            return `No matches found for pattern ${params.pattern}.`;
          }
          if (execError.code === "ENOENT") {
            throw new Error("ripgrep (rg) is required for grep but is not installed.");
          }
          throw new Error(execError.stderr?.trim() || execError.message || "grep failed");
        }
      },
      {
        attributes: {
          pattern: params.pattern,
          path: getRequestedPath(params) ?? ".",
          include: params.include,
          limit: params.limit,
          literal: params.literal === true,
          caseSensitive: params.caseSensitive === true,
        },
      },
    );
  }

  async statPath(params: StatParams) {
    return traceSpan(
      "tool.stat_path",
      async () => {
        const { resolved } = resolveToolPath(params);
        this.authorizePath(resolved);
        const stat = await ensurePathExists(resolved, "Path");
        return buildStatPathResult({
          resolvedPath: resolved,
          type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          createdAt: stat.birthtime.toISOString(),
          format: params.format,
        });
      },
      {
        attributes: {
          path: getRequestedPath(params),
        },
      },
    );
  }

  async mkdir(params: MkdirParams) {
    return traceSpan(
      "tool.mkdir",
      async () => {
        const { resolved } = resolveToolPath(params);
        this.authorizePath(resolved);
        await fs.mkdir(resolved, { recursive: params.recursive ?? true });
        return `Created directory ${resolved}.`;
      },
      {
        attributes: {
          path: getRequestedPath(params),
          recursive: params.recursive ?? true,
        },
      },
    );
  }

  async movePath(params: CopyMoveParams) {
    return traceSpan(
      "tool.move_path",
      async () => {
        const source = params.source ?? params.src;
        const destination = params.destination ?? params.dst;
        if (!source || !destination) {
          throw new Error("source and destination are required");
        }
        const resolvedSource = resolveToolPath({ path: source, cwd: params.cwd }).resolved;
        const resolvedDestination = resolveToolPath({ path: destination, cwd: params.cwd }).resolved;
        this.authorizePath(resolvedSource);
        this.authorizePath(resolvedDestination);
        await ensurePathExists(resolvedSource, "Source path");
        await fs.mkdir(path.dirname(resolvedDestination), { recursive: true });
        await fs.rename(resolvedSource, resolvedDestination);
        return `Moved ${resolvedSource} to ${resolvedDestination}.`;
      },
      {
        attributes: {
          source: params.source ?? params.src,
          destination: params.destination ?? params.dst,
        },
      },
    );
  }

  async copyPath(params: CopyMoveParams) {
    return traceSpan(
      "tool.copy_path",
      async () => {
        const source = params.source ?? params.src;
        const destination = params.destination ?? params.dst;
        if (!source || !destination) {
          throw new Error("source and destination are required");
        }
        const resolvedSource = resolveToolPath({ path: source, cwd: params.cwd }).resolved;
        const resolvedDestination = resolveToolPath({ path: destination, cwd: params.cwd }).resolved;
        this.authorizePath(resolvedSource);
        this.authorizePath(resolvedDestination);
        const stat = await ensurePathExists(resolvedSource, "Source path");
        if (stat.isDirectory() && !params.recursive) {
          throw new Error(`Source path is a directory. Set recursive=true to copy it: ${resolvedSource}`);
        }
        await fs.mkdir(path.dirname(resolvedDestination), { recursive: true });
        if (stat.isDirectory()) {
          await fs.cp(resolvedSource, resolvedDestination, { recursive: true });
        } else {
          await fs.copyFile(resolvedSource, resolvedDestination);
        }
        return `Copied ${resolvedSource} to ${resolvedDestination}.`;
      },
      {
        attributes: {
          source: params.source ?? params.src,
          destination: params.destination ?? params.dst,
          recursive: params.recursive === true,
        },
      },
    );
  }

  async deletePath(params: DeleteParams) {
    return traceSpan(
      "tool.delete_path",
      async () => {
        const { resolved } = resolveToolPath(params);
        this.authorizePath(resolved);
        const stat = await ensurePathExists(resolved, "Path");
        if (stat.isDirectory() && !params.recursive) {
          throw new Error(`Path is a directory. Set recursive=true to delete it: ${resolved}`);
        }
        await fs.rm(resolved, { recursive: params.recursive === true, force: false });
        return `Deleted ${resolved}.`;
      },
      {
        attributes: {
          path: getRequestedPath(params),
          recursive: params.recursive === true,
        },
      },
    );
  }
}
