import path from "node:path";
import type { ProfileRecord } from "../domain/profiles";
import { ProfileService } from "./profile-service";
import type { ShellService } from "./infrastructure/shell-service";
import type {
  FilesystemBackend,
  ReadFileResult,
  StatResult,
  ListDirResult,
  GlobResult,
  GrepResult,
} from "./filesystem-backend";

const REMOTE_FILESYSTEM_SCRIPT = String.raw`
import base64
import fnmatch
import glob
import json
import os
import re
import shutil
import stat
import sys

REQUEST = json.loads(base64.b64decode(os.environ["OPENELINARO_SSH_FS_REQUEST"]).decode("utf-8"))

def is_probably_binary(file_path):
    with open(file_path, "rb") as handle:
        data = handle.read(8192)
    if not data:
        return False
    suspicious = 0
    for value in data:
        if value == 0:
            return True
        if value < 7 or (value > 14 and value < 32):
            suspicious += 1
    return suspicious / len(data) > 0.3

def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))

def list_entries(root_path, recursive, limit):
    entries = []
    if not recursive:
        for name in sorted(os.listdir(root_path)):
            candidate = os.path.join(root_path, name)
            entries.append(f"{name}/" if os.path.isdir(candidate) else name)
        return entries[:limit], len(entries), len(entries) > limit
    for current_root, dir_names, file_names in os.walk(root_path):
        dir_names.sort()
        file_names.sort()
        relative_root = os.path.relpath(current_root, root_path)
        for name in dir_names:
            relative = name if relative_root == "." else f"{relative_root}/{name}"
            entries.append(f"{relative}/")
            if len(entries) >= limit:
                return entries, None, True
        for name in file_names:
            relative = name if relative_root == "." else f"{relative_root}/{name}"
            entries.append(relative)
            if len(entries) >= limit:
                return entries, None, True
    return entries, len(entries), False

try:
    op = REQUEST["op"]
    if op == "read":
        target = REQUEST["path"]
        details = os.stat(target)
        if stat.S_ISDIR(details.st_mode):
            entries = []
            for name in sorted(os.listdir(target)):
                candidate = os.path.join(target, name)
                entries.append(f"{name}/" if os.path.isdir(candidate) else name)
            emit({"type": "directory", "entries": entries})
        else:
            if is_probably_binary(target):
                raise RuntimeError(f"Cannot read binary file: {target}")
            with open(target, "r", encoding="utf-8") as handle:
                emit({"type": "file", "content": handle.read()})
    elif op == "write":
        target = REQUEST["path"]
        os.makedirs(os.path.dirname(target), exist_ok=True)
        mode = "a" if REQUEST.get("append") else "w"
        with open(target, mode, encoding="utf-8") as handle:
            handle.write(REQUEST["content"])
        emit({"sizeBytes": os.stat(target).st_size})
    elif op == "list_dir":
        target = REQUEST["path"]
        entries, total_entries, truncated = list_entries(
            target,
            bool(REQUEST.get("recursive")),
            int(REQUEST.get("limit", 200)),
        )
        emit({
            "entries": entries,
            "totalEntries": total_entries,
            "truncated": truncated,
        })
    elif op == "glob":
        root_path = REQUEST["path"]
        pattern = REQUEST["pattern"]
        limit = int(REQUEST.get("limit", 200))
        matches = sorted(glob.glob(os.path.join(root_path, pattern), recursive=True))
        emit({"matches": matches[:limit], "truncated": len(matches) > limit})
    elif op == "grep":
        root_path = REQUEST["path"]
        pattern = REQUEST["pattern"]
        include = REQUEST.get("include")
        limit = int(REQUEST.get("limit", 100))
        literal = bool(REQUEST.get("literal"))
        case_sensitive = bool(REQUEST.get("caseSensitive"))
        flags = 0 if case_sensitive else re.IGNORECASE
        matcher = None if literal else re.compile(pattern, flags)
        needle = pattern if case_sensitive else pattern.lower()
        matches = []
        for current_root, dir_names, file_names in os.walk(root_path):
            dir_names.sort()
            file_names.sort()
            for name in file_names:
                candidate = os.path.join(current_root, name)
                relative = os.path.relpath(candidate, root_path)
                if include and not fnmatch.fnmatch(relative, include):
                    continue
                if is_probably_binary(candidate):
                    continue
                with open(candidate, "r", encoding="utf-8", errors="replace") as handle:
                    for line_number, line in enumerate(handle, start=1):
                        subject = line.rstrip("\n")
                        haystack = subject if case_sensitive else subject.lower()
                        found = (needle in haystack) if literal else bool(matcher.search(subject))
                        if found:
                            matches.append({
                                "path": candidate,
                                "lineNumber": line_number,
                                "text": subject,
                            })
                            if len(matches) >= limit:
                                emit({"matches": matches, "truncated": True})
                                sys.exit(0)
        emit({"matches": matches, "truncated": False})
    elif op == "stat":
        target = REQUEST["path"]
        details = os.stat(target)
        if stat.S_ISDIR(details.st_mode):
            item_type = "directory"
        elif stat.S_ISREG(details.st_mode):
            item_type = "file"
        else:
            item_type = "other"
        emit({
            "type": item_type,
            "sizeBytes": details.st_size,
            "modifiedAt": details.st_mtime,
            "createdAt": details.st_ctime,
        })
    elif op == "mkdir":
        target = REQUEST["path"]
        os.makedirs(target, exist_ok=bool(REQUEST.get("recursive", True)))
        emit({"created": True})
    elif op == "move_path":
        shutil.move(REQUEST["source"], REQUEST["destination"])
        emit({"moved": True})
    elif op == "copy_path":
        source = REQUEST["source"]
        destination = REQUEST["destination"]
        if os.path.isdir(source):
            if not REQUEST.get("recursive"):
                raise RuntimeError(f"Source path is a directory. Set recursive=true to copy it: {source}")
            shutil.copytree(source, destination, dirs_exist_ok=True)
        else:
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            shutil.copy2(source, destination)
        emit({"copied": True})
    elif op == "delete_path":
        target = REQUEST["path"]
        if os.path.isdir(target):
            if not REQUEST.get("recursive"):
                raise RuntimeError(f"Path is a directory. Set recursive=true to delete it: {target}")
            shutil.rmtree(target)
        else:
            os.remove(target)
        emit({"deleted": True})
    else:
        raise RuntimeError(f"Unsupported filesystem op: {op}")
except Exception as error:
    emit({"error": str(error)})
    sys.exit(1)
`;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function formatTimestamp(value: number) {
  return new Date(value * 1000).toISOString();
}

export class SshFilesystemBackend implements FilesystemBackend {
  private readonly profiles: ProfileService;

  constructor(
    private readonly profile: ProfileRecord,
    private readonly shell: Pick<ShellService, "exec">,
  ) {
    this.profiles = new ProfileService(profile.id);
  }

  resolveCwd(cwd?: string) {
    const fallback = this.profiles.getDefaultToolCwd(this.profile);
    const requested = cwd?.trim() || fallback;
    if (!requested) {
      throw new Error(`No default remote cwd is configured for profile ${this.profile.id}.`);
    }
    return path.posix.isAbsolute(requested)
      ? path.posix.normalize(requested)
      : path.posix.resolve(fallback ?? "/", requested);
  }

  resolvePath(requestedPath: string, cwd: string) {
    return path.posix.isAbsolute(requestedPath)
      ? path.posix.normalize(requestedPath)
      : path.posix.resolve(cwd, requestedPath);
  }

  private async runOperation<T>(request: Record<string, unknown>): Promise<T> {
    const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
    const command = `OPENELINARO_SSH_FS_REQUEST=${shellQuote(payload)} python3 - <<'PY'\n${REMOTE_FILESYSTEM_SCRIPT}\nPY`;
    const result = await this.shell.exec({ command });
    let parsed: ({ error?: string } & T) | null = null;
    try {
      parsed = JSON.parse(result.stdout) as { error?: string } & T;
    } catch {
      parsed = null;
    }
    if (result.exitCode !== 0) {
      if (parsed?.error) {
        throw new Error(parsed.error);
      }
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Remote filesystem operation failed.");
    }
    if (!parsed) {
      throw new Error("Remote filesystem operation returned invalid JSON.");
    }
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    return parsed;
  }

  async readFileOrDir(targetPath: string): Promise<ReadFileResult> {
    const result = await this.runOperation<
      | { type: "directory"; entries: string[] }
      | { type: "file"; content: string }
    >({
      op: "read",
      path: targetPath,
    });

    if (result.type === "directory") {
      const entries = result.entries.map((name) => {
        const isDir = name.endsWith("/");
        return {
          name: isDir ? name.slice(0, -1) : name,
          isDirectory: isDir,
        };
      });
      return { type: "directory", entries };
    }

    return { type: "file", content: result.content };
  }

  async writeFile(targetPath: string, content: string, append: boolean) {
    return await this.runOperation<{ sizeBytes: number }>({
      op: "write",
      path: targetPath,
      content,
      append,
    });
  }

  async stat(targetPath: string): Promise<StatResult | null> {
    try {
      const result = await this.runOperation<{
        type: "directory" | "file" | "other";
        sizeBytes: number;
        modifiedAt: number;
        createdAt: number;
      }>({
        op: "stat",
        path: targetPath,
      });
      return {
        type: result.type,
        sizeBytes: result.sizeBytes,
        modifiedAt: formatTimestamp(result.modifiedAt),
        createdAt: formatTimestamp(result.createdAt),
      };
    } catch {
      return null;
    }
  }

  async statOrThrow(targetPath: string): Promise<StatResult> {
    const result = await this.stat(targetPath);
    if (!result) {
      throw new Error(`Path not found: ${targetPath}`);
    }
    return result;
  }

  async listDir(targetPath: string, recursive: boolean, limit: number): Promise<ListDirResult> {
    return await this.runOperation<ListDirResult>({
      op: "list_dir",
      path: targetPath,
      recursive,
      limit,
    });
  }

  async glob(targetPath: string, pattern: string, limit: number): Promise<GlobResult> {
    return await this.runOperation<GlobResult>({
      op: "glob",
      path: targetPath,
      pattern,
      limit,
    });
  }

  async grep(
    searchRoot: string,
    pattern: string,
    include: string | undefined,
    limit: number,
    literal: boolean,
    caseSensitive: boolean,
  ): Promise<GrepResult> {
    const result = await this.runOperation<{
      matches: Array<{ path: string; lineNumber: number; text: string }>;
      truncated: boolean;
    }>({
      op: "grep",
      path: searchRoot,
      pattern,
      include,
      limit,
      literal,
      caseSensitive,
    });
    return {
      matches: result.matches,
      totalMatchCount: result.truncated ? null : result.matches.length,
      truncated: result.truncated,
    };
  }

  async mkdir(targetPath: string, recursive: boolean) {
    await this.runOperation({
      op: "mkdir",
      path: targetPath,
      recursive,
    });
  }

  async movePath(source: string, destination: string) {
    await this.runOperation({
      op: "move_path",
      source,
      destination,
    });
  }

  async copyPath(source: string, destination: string, recursive: boolean) {
    await this.runOperation({
      op: "copy_path",
      source,
      destination,
      recursive,
    });
  }

  async deletePath(targetPath: string, recursive: boolean) {
    await this.runOperation({
      op: "delete_path",
      path: targetPath,
      recursive,
    });
  }

}
