import path from "node:path";
import type { ProfileRecord } from "../domain/profiles";
import { AccessControlService } from "./access-control-service";
import { ProfileService } from "./profile-service";
import { SshShellService } from "./ssh-shell-service";
import {
  applyStructuredUpdate,
  buildAddedFileContent,
  parseStructuredPatch,
} from "./structured-patch";
import { telemetry } from "./telemetry";

const DEFAULT_READ_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_GLOB_LIMIT = 200;
const DEFAULT_GREP_LIMIT = 100;
const MAX_LINE_LENGTH = 2_000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_READ_BYTES_LABEL = `${MAX_READ_BYTES / 1024} KB`;
const sshFilesystemTelemetry = telemetry.child({ component: "ssh_filesystem" });

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

function getRequestedPath(input: ResolvedPathInput) {
  return input.path ?? input.filePath;
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
  sizeBytes: number;
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

function formatTimestamp(value: number) {
  return new Date(value * 1000).toISOString();
}

function traceSpan<T>(
  operation: string,
  fn: () => Promise<T>,
  options?: { attributes?: Record<string, unknown> },
) {
  return sshFilesystemTelemetry.span(operation, options?.attributes ?? {}, fn);
}

export class SshFilesystemService {
  private readonly profiles: ProfileService;

  constructor(
    private readonly profile: ProfileRecord,
    private readonly shell: Pick<SshShellService, "exec">,
    private readonly access?: AccessControlService,
  ) {
    this.profiles = new ProfileService(profile.id);
  }

  private resolveCwd(cwd?: string) {
    const fallback = this.profiles.getDefaultToolCwd(this.profile);
    const requested = cwd?.trim() || fallback;
    if (!requested) {
      throw new Error(`No default remote cwd is configured for profile ${this.profile.id}.`);
    }
    return path.posix.isAbsolute(requested)
      ? path.posix.normalize(requested)
      : path.posix.resolve(fallback ?? "/", requested);
  }

  private resolveToolPath(input: ResolvedPathInput) {
    const requestedPath = getRequestedPath(input);
    if (!requestedPath) {
      throw new Error("path is required");
    }
    const cwd = this.resolveCwd(input.cwd);
    const resolved = path.posix.isAbsolute(requestedPath)
      ? path.posix.normalize(requestedPath)
      : path.posix.resolve(cwd, requestedPath);
    return { cwd, requestedPath, resolved };
  }

  private authorizePath(targetPath: string) {
    return this.access ? this.access.assertPathAccess(targetPath) : targetPath;
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

  private async statSafe(targetPath: string) {
    try {
      return await this.runOperation<{
        type: "directory" | "file" | "other";
        sizeBytes: number;
        modifiedAt: number;
        createdAt: number;
      }>({
        op: "stat",
        path: targetPath,
      });
    } catch {
      return null;
    }
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

        const { resolved } = this.resolveToolPath(params);
        this.authorizePath(resolved);
        const result = await this.runOperation<
          | { type: "directory"; entries: string[] }
          | { type: "file"; content: string }
        >({
          op: "read",
          path: resolved,
        });

        if (result.type === "directory") {
          if (result.entries.length > 0 && offset > result.entries.length) {
            throw new Error(`Offset ${offset} is out of range for this directory (${result.entries.length} entries)`);
          }
          return formatDirectoryEntries(result.entries, offset, limit, resolved);
        }

        const lines = splitFileLines(result.content);
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
        const { resolved } = this.resolveToolPath(params);
        this.authorizePath(resolved);
        const result = await this.runOperation<{ sizeBytes: number }>({
          op: "write",
          path: resolved,
          content: params.content,
          append: params.append === true,
        });
        return `${params.append ? "Appended" : "Wrote"} ${Buffer.byteLength(params.content, "utf8")} bytes to ${resolved}. File size is now ${result.sizeBytes} bytes.`;
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
        const { resolved } = this.resolveToolPath(params);
        this.authorizePath(resolved);
        const current = await this.runOperation<{ type: "file"; content: string }>({
          op: "read",
          path: resolved,
        });
        if (current.type !== "file") {
          throw new Error(`Path is a directory, not a file: ${resolved}`);
        }

        const ending = detectLineEnding(current.content);
        const next = normalizeEditStrings(params);
        const oldString = convertToLineEnding(normalizeLineEndings(next.oldString), ending);
        const newString = convertToLineEnding(normalizeLineEndings(next.newString), ending);
        const result = applyOneEdit(
          current.content,
          { oldString, newString, replaceAll: params.replaceAll },
          resolved,
        );
        await this.runOperation({
          op: "write",
          path: resolved,
          content: result.content,
          append: false,
        });
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
        const { resolved } = this.resolveToolPath(params);
        this.authorizePath(resolved);
        if (params.edits.length === 0) {
          throw new Error("edits must contain at least one edit");
        }
        const current = await this.runOperation<{ type: "file"; content: string }>({
          op: "read",
          path: resolved,
        });
        if (current.type !== "file") {
          throw new Error(`Path is a directory, not a file: ${resolved}`);
        }

        const ending = detectLineEnding(current.content);
        let content = current.content;
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
        await this.runOperation({
          op: "write",
          path: resolved,
          content,
          append: false,
        });
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
          const resolvedPath = this.resolveToolPath({ path: operation.path, cwd: params.cwd }).resolved;
          this.authorizePath(resolvedPath);

          if (operation.type === "add") {
            const existing = await this.statSafe(resolvedPath);
            if (existing) {
              throw new Error(`Add File target already exists: ${resolvedPath}`);
            }
            await this.runOperation({
              op: "write",
              path: resolvedPath,
              content: buildAddedFileContent(operation.lines),
              append: false,
            });
            summaries.push(`A ${resolvedPath}`);
            continue;
          }

          const current = await this.runOperation<{ type: "file"; content: string }>({
            op: "read",
            path: resolvedPath,
          });
          if (current.type !== "file") {
            throw new Error(`Path is a directory, not a file: ${resolvedPath}`);
          }

          if (operation.type === "delete") {
            await this.runOperation({
              op: "delete_path",
              path: resolvedPath,
              recursive: false,
            });
            summaries.push(`D ${resolvedPath}`);
            continue;
          }

          const ending = detectLineEnding(current.content);
          const nextContent = convertToLineEnding(
            applyStructuredUpdate(current.content, operation.chunks),
            ending,
          );
          const moveTarget = operation.moveTo
            ? this.resolveToolPath({ path: operation.moveTo, cwd: params.cwd }).resolved
            : undefined;
          if (moveTarget) {
            this.authorizePath(moveTarget);
          }

          if (moveTarget && moveTarget !== resolvedPath) {
            const existingTarget = await this.statSafe(moveTarget);
            if (existingTarget) {
              throw new Error(`Move target already exists: ${moveTarget}`);
            }
            await this.runOperation({
              op: "write",
              path: moveTarget,
              content: nextContent,
              append: false,
            });
            await this.runOperation({
              op: "delete_path",
              path: resolvedPath,
              recursive: false,
            });
            summaries.push(`M ${resolvedPath} -> ${moveTarget}`);
            continue;
          }

          await this.runOperation({
            op: "write",
            path: resolvedPath,
            content: nextContent,
            append: false,
          });
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
        const { resolved } = this.resolveToolPath({ ...params, path: params.path ?? "." });
        this.authorizePath(resolved);
        const result = await this.runOperation<{
          entries: string[];
          totalEntries: number | null;
          truncated: boolean;
        }>({
          op: "list_dir",
          path: resolved,
          recursive: params.recursive === true,
          limit,
        });
        return buildListDirResult({
          resolvedPath: resolved,
          entries: result.entries,
          limit,
          recursive: params.recursive === true,
          totalEntries: result.totalEntries,
          truncated: result.truncated,
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
        const { resolved } = this.resolveToolPath({ ...params, path: params.path ?? "." });
        this.authorizePath(resolved);
        const result = await this.runOperation<{ matches: string[]; truncated: boolean }>({
          op: "glob",
          path: resolved,
          pattern: params.pattern,
          limit,
        });
        if (result.matches.length === 0) {
          return `No paths matched pattern ${params.pattern} under ${resolved}.`;
        }
        return [
          `Pattern: ${params.pattern}`,
          `Path: ${resolved}`,
          "Matches:",
          result.matches.join("\n"),
          result.truncated ? `(Results truncated at ${limit} matches.)` : `(Total ${result.matches.length} matches)`,
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
        const { resolved } = this.resolveToolPath({ ...params, path: params.path ?? "." });
        this.authorizePath(resolved);
        const stat = await this.statPath({
          path: resolved,
          cwd: undefined,
          format: "json",
        }) as { path: string; type: "file" | "directory" | "other"; sizeBytes: number; modifiedAt: string | null; createdAt: string | null };
        const searchRoot = stat.type === "directory" ? resolved : path.dirname(resolved);
        const include = stat.type === "directory" ? params.include : path.basename(resolved);
        const result = await this.runOperation<{
          matches: Array<{ path: string; lineNumber: number; text: string }>;
          truncated: boolean;
        }>({
          op: "grep",
          path: searchRoot,
          pattern: params.pattern,
          include,
          limit,
          literal: params.literal === true,
          caseSensitive: params.caseSensitive === true,
        });
        if (result.matches.length === 0) {
          return `No matches found for pattern ${params.pattern}.`;
        }
        const output = result.matches
          .map((entry) => `${entry.path}:${entry.lineNumber}: ${truncateLine(entry.text)}`)
          .join("\n");
        return [
          `Pattern: ${params.pattern}`,
          `Path: ${resolved}`,
          "Matches:",
          output,
          result.truncated
            ? `(Results truncated: showing ${result.matches.length} of at least ${result.matches.length} matches.)`
            : `(Total ${result.matches.length} matches)`,
        ].join("\n");
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
        const { resolved } = this.resolveToolPath(params);
        this.authorizePath(resolved);
        const result = await this.runOperation<{
          type: "directory" | "file" | "other";
          sizeBytes: number;
          modifiedAt: number;
          createdAt: number;
        }>({
          op: "stat",
          path: resolved,
        });
        return buildStatPathResult({
          resolvedPath: resolved,
          type: result.type,
          sizeBytes: result.sizeBytes,
          modifiedAt: formatTimestamp(result.modifiedAt),
          createdAt: formatTimestamp(result.createdAt),
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
        const { resolved } = this.resolveToolPath(params);
        this.authorizePath(resolved);
        await this.runOperation({
          op: "mkdir",
          path: resolved,
          recursive: params.recursive ?? true,
        });
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
        const resolvedSource = this.resolveToolPath({ path: source, cwd: params.cwd }).resolved;
        const resolvedDestination = this.resolveToolPath({ path: destination, cwd: params.cwd }).resolved;
        this.authorizePath(resolvedSource);
        this.authorizePath(resolvedDestination);
        await this.runOperation({
          op: "move_path",
          source: resolvedSource,
          destination: resolvedDestination,
        });
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
        const resolvedSource = this.resolveToolPath({ path: source, cwd: params.cwd }).resolved;
        const resolvedDestination = this.resolveToolPath({ path: destination, cwd: params.cwd }).resolved;
        this.authorizePath(resolvedSource);
        this.authorizePath(resolvedDestination);
        await this.runOperation({
          op: "copy_path",
          source: resolvedSource,
          destination: resolvedDestination,
          recursive: params.recursive === true,
        });
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
        const { resolved } = this.resolveToolPath(params);
        this.authorizePath(resolved);
        await this.runOperation({
          op: "delete_path",
          path: resolved,
          recursive: params.recursive === true,
        });
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
