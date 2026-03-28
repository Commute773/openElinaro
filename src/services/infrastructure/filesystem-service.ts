import path from "node:path";
import { AccessControlService } from "../access-control-service";
import { NotFoundError, ValidationError } from "../../domain/errors";
import type { FilesystemBackend } from "../filesystem-backend";
import { LocalFilesystemBackend } from "../filesystem-backend-local";
import {
  applyStructuredUpdate,
  buildAddedFileContent,
  parseStructuredPatch,
} from "../structured-patch";
import { telemetry } from "./telemetry";
import { createTraceSpan } from "../../utils/telemetry-helpers";

import {
  FS_DEFAULT_READ_LIMIT as DEFAULT_READ_LIMIT,
  FS_DEFAULT_LIST_LIMIT as DEFAULT_LIST_LIMIT,
  FS_DEFAULT_GLOB_LIMIT as DEFAULT_GLOB_LIMIT,
  FS_DEFAULT_GREP_LIMIT as DEFAULT_GREP_LIMIT,
  FS_MAX_LINE_LENGTH as MAX_LINE_LENGTH,
  FS_MAX_READ_BYTES as MAX_READ_BYTES,
  FS_MAX_READ_BYTES_LABEL as MAX_READ_BYTES_LABEL,
} from "../../config/service-constants";
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
    throw new ValidationError("oldString is required");
  }
  if (newString === undefined) {
    throw new ValidationError("newString is required");
  }
  if (oldString === newString) {
    throw new ValidationError("No changes to apply: oldString and newString are identical.");
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
    throw new ValidationError(`${label}: oldString was not found in ${filePath}`);
  }

  if (!edit.replaceAll && matchCount > 1) {
    throw new ValidationError(
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

const traceSpan = createTraceSpan(filesystemTelemetry);

function isFilesystemBackend(value: unknown): value is FilesystemBackend {
  return typeof value === "object" && value !== null && "resolveCwd" in value;
}

export class FilesystemService {
  private readonly backend: FilesystemBackend;
  private readonly access?: AccessControlService;

  constructor(backendOrAccess?: FilesystemBackend | AccessControlService, access?: AccessControlService) {
    if (!backendOrAccess) {
      this.backend = new LocalFilesystemBackend();
    } else if (isFilesystemBackend(backendOrAccess)) {
      this.backend = backendOrAccess;
      this.access = access;
    } else {
      this.backend = new LocalFilesystemBackend();
      this.access = backendOrAccess;
    }
  }

  private authorizePath(targetPath: string) {
    return this.access ? this.access.assertPathAccess(targetPath) : targetPath;
  }

  private resolveToolPath(input: ResolvedPathInput) {
    const requestedPath = getRequestedPath(input);
    if (!requestedPath) {
      throw new ValidationError("path is required");
    }
    const cwd = this.backend.resolveCwd(input.cwd);
    const resolved = this.backend.resolvePath(requestedPath, cwd);
    return { cwd, requestedPath, resolved };
  }

  async read(params: ReadParams) {
    return traceSpan(
      "tool.read_file",
      async () => {
        const offset = params.offset ?? 1;
        const limit = params.limit ?? DEFAULT_READ_LIMIT;
        if (offset < 1) {
          throw new ValidationError("offset must be greater than or equal to 1");
        }
        if (limit < 1) {
          throw new ValidationError("limit must be greater than or equal to 1");
        }

        const { resolved } = this.resolveToolPath(params);
        this.authorizePath(resolved);
        await this.backend.statOrThrow(resolved);
        const result = await this.backend.readFileOrDir(resolved);

        if (result.type === "directory") {
          const entries = result.entries
            .map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`)
            .sort((left, right) => left.localeCompare(right));
          if (entries.length > 0 && offset > entries.length) {
            throw new ValidationError(`Offset ${offset} is out of range for this directory (${entries.length} entries)`);
          }
          return formatDirectoryEntries(entries, offset, limit, resolved);
        }

        const lines = splitFileLines(result.content);
        if (offset > lines.length && !(lines.length === 0 && offset === 1)) {
          throw new ValidationError(`Offset ${offset} is out of range for this file (${lines.length} lines)`);
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
        const existing = await this.backend.stat(resolved);
        if (existing?.type === "directory") {
          throw new ValidationError(`Path is a directory, not a file: ${resolved}`);
        }
        const result = await this.backend.writeFile(resolved, params.content, params.append === true);
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
        await this.backend.statOrThrow(resolved);
        const readResult = await this.backend.readFileOrDir(resolved);
        if (readResult.type !== "file") {
          throw new ValidationError(`Path is a directory, not a file: ${resolved}`);
        }

        const originalContent = readResult.content;
        const ending = detectLineEnding(originalContent);
        const next = normalizeEditStrings(params);
        const oldString = convertToLineEnding(normalizeLineEndings(next.oldString), ending);
        const newString = convertToLineEnding(normalizeLineEndings(next.newString), ending);
        const result = applyOneEdit(
          originalContent,
          { oldString, newString, replaceAll: params.replaceAll },
          resolved,
        );
        await this.backend.writeFile(resolved, result.content, false);
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
            const existing = await this.backend.stat(resolvedPath);
            if (existing) {
              throw new ValidationError(`Add File target already exists: ${resolvedPath}`);
            }
            await this.backend.writeFile(resolvedPath, buildAddedFileContent(operation.lines), false);
            summaries.push(`A ${resolvedPath}`);
            continue;
          }

          await this.backend.statOrThrow(resolvedPath);
          const readResult = await this.backend.readFileOrDir(resolvedPath);
          if (readResult.type !== "file") {
            throw new ValidationError(`Path is a directory, not a file: ${resolvedPath}`);
          }

          if (operation.type === "delete") {
            await this.backend.deletePath(resolvedPath, false);
            summaries.push(`D ${resolvedPath}`);
            continue;
          }

          const originalContent = readResult.content;
          const ending = detectLineEnding(originalContent);
          const nextContent = convertToLineEnding(
            applyStructuredUpdate(originalContent, operation.chunks),
            ending,
          );
          const moveTarget = operation.moveTo
            ? this.resolveToolPath({ path: operation.moveTo, cwd: params.cwd }).resolved
            : undefined;
          if (moveTarget) {
            this.authorizePath(moveTarget);
          }

          if (moveTarget && moveTarget !== resolvedPath) {
            const existingTarget = await this.backend.stat(moveTarget);
            if (existingTarget) {
              throw new ValidationError(`Move target already exists: ${moveTarget}`);
            }
            await this.backend.writeFile(moveTarget, nextContent, false);
            await this.backend.deletePath(resolvedPath, false);
            summaries.push(`M ${resolvedPath} -> ${moveTarget}`);
            continue;
          }

          await this.backend.writeFile(resolvedPath, nextContent, false);
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
          throw new ValidationError("limit must be greater than or equal to 1");
        }

        const { resolved } = this.resolveToolPath({ ...params, path: params.path ?? "." });
        this.authorizePath(resolved);
        const stat = await this.backend.statOrThrow(resolved);
        if (stat.type !== "directory") {
          throw new ValidationError(`Path is not a directory: ${resolved}`);
        }

        const result = await this.backend.listDir(resolved, params.recursive === true, limit);
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
          throw new ValidationError("limit must be greater than or equal to 1");
        }
        const { resolved } = this.resolveToolPath({ ...params, path: params.path ?? "." });
        this.authorizePath(resolved);
        const stat = await this.backend.statOrThrow(resolved);
        if (stat.type !== "directory") {
          throw new ValidationError(`Path is not a directory: ${resolved}`);
        }

        const result = await this.backend.glob(resolved, params.pattern, limit);
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
          throw new ValidationError("limit must be greater than or equal to 1");
        }
        const { resolved } = this.resolveToolPath({ ...params, path: params.path ?? "." });
        this.authorizePath(resolved);
        const stat = await this.backend.statOrThrow(resolved);
        const searchRoot = stat.type === "directory" ? resolved : path.dirname(resolved);
        const include = stat.type !== "directory"
          ? path.basename(resolved)
          : params.include;

        const result = await this.backend.grep(
          searchRoot,
          params.pattern,
          include,
          limit,
          params.literal === true,
          params.caseSensitive === true,
        );

        if (result.matches.length === 0) {
          return `No matches found for pattern ${params.pattern}.`;
        }
        const output = result.matches
          .map((entry) => `${entry.path}:${entry.lineNumber}: ${entry.text}`)
          .join("\n");
        return [
          `Pattern: ${params.pattern}`,
          `Path: ${resolved}`,
          "Matches:",
          output,
          result.truncated
            ? result.totalMatchCount !== null
              ? `(Results truncated: showing ${limit} of ${result.totalMatchCount} matches.)`
              : `(Results truncated: showing ${result.matches.length} of at least ${result.matches.length} matches.)`
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
        const stat = await this.backend.statOrThrow(resolved);
        return buildStatPathResult({
          resolvedPath: resolved,
          type: stat.type,
          sizeBytes: stat.sizeBytes,
          modifiedAt: stat.modifiedAt,
          createdAt: stat.createdAt,
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
        await this.backend.mkdir(resolved, params.recursive ?? true);
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
          throw new ValidationError("source and destination are required");
        }
        const resolvedSource = this.resolveToolPath({ path: source, cwd: params.cwd }).resolved;
        const resolvedDestination = this.resolveToolPath({ path: destination, cwd: params.cwd }).resolved;
        this.authorizePath(resolvedSource);
        this.authorizePath(resolvedDestination);
        await this.backend.statOrThrow(resolvedSource);
        await this.backend.movePath(resolvedSource, resolvedDestination);
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
          throw new ValidationError("source and destination are required");
        }
        const resolvedSource = this.resolveToolPath({ path: source, cwd: params.cwd }).resolved;
        const resolvedDestination = this.resolveToolPath({ path: destination, cwd: params.cwd }).resolved;
        this.authorizePath(resolvedSource);
        this.authorizePath(resolvedDestination);
        await this.backend.statOrThrow(resolvedSource);
        await this.backend.copyPath(resolvedSource, resolvedDestination, params.recursive === true);
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
        await this.backend.statOrThrow(resolved);
        await this.backend.deletePath(resolved, params.recursive === true);
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
