/**
 * Filesystem function definitions.
 * Migrated from src/tools/groups/filesystem-tools.ts.
 * These produce agent tools, API routes, and Discord commands from a single source.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";

// ---------------------------------------------------------------------------
// Schemas (same as filesystem-tools.ts)
// ---------------------------------------------------------------------------

const responseFormatSchema = z.enum(["text", "json"]);

const pathSchema = z.object({
  path: z.string().optional(),
  filePath: z.string().optional(),
  cwd: z.string().optional(),
});

const readFileSchema = pathSchema.extend({
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(2_000).optional(),
});

const writeFileSchema = pathSchema.extend({
  content: z.string(),
  append: z.boolean().optional(),
});

const editFileSchema = pathSchema.extend({
  oldString: z.string().optional(),
  old_string: z.string().optional(),
  newString: z.string().optional(),
  new_string: z.string().optional(),
  replaceAll: z.boolean().optional(),
});

const applyPatchSchema = z.object({
  patchText: z.string().min(1),
  cwd: z.string().optional(),
});

const listDirSchema = pathSchema.extend({
  recursive: z.boolean().optional(),
  limit: z.number().int().min(1).max(2_000).optional(),
  format: responseFormatSchema.optional(),
});

const globSchema = pathSchema.extend({
  pattern: z.string().min(1),
  limit: z.number().int().min(1).max(2_000).optional(),
});

const grepSchema = pathSchema.extend({
  pattern: z.string().min(1),
  include: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  literal: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
});

const statPathSchema = pathSchema.extend({
  format: responseFormatSchema.optional(),
});

const mkdirSchema = pathSchema.extend({
  recursive: z.boolean().optional(),
});

const copyMoveSchema = z.object({
  source: z.string().optional(),
  src: z.string().optional(),
  destination: z.string().optional(),
  dst: z.string().optional(),
  cwd: z.string().optional(),
  recursive: z.boolean().optional(),
});

const deletePathSchema = pathSchema.extend({
  recursive: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Auth / metadata defaults
// ---------------------------------------------------------------------------

const FS_AUTH = { access: "anyone" as const, behavior: "role-sensitive" as const, note: "Filesystem paths are restricted by project and memory permissions." };
const FS_SCOPES: ("chat" | "coding-planner" | "coding-worker" | "direct")[] = ["chat", "coding-planner", "coding-worker", "direct"];
const FS_DOMAINS = ["filesystem", "code"];

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildFilesystemFunctions: FunctionDomainBuilder = (ctx) => [
  // -------------------------------------------------------------------------
  // read_file
  // -------------------------------------------------------------------------
  defineFunction({
    name: "read_file",
    description:
      "Read a file or directory. File reads return numbered lines. Directory reads return entries. Supports offset and limit for paging.",
    input: readFileSchema,
    handler: async (input, fnCtx) => fnCtx.services.filesystem.read(input),
    auth: FS_AUTH,
    domains: FS_DOMAINS,
    agentScopes: FS_SCOPES,
    defaultVisibleScopes: ["coding-planner", "coding-worker"],
    examples: ["read package.json", "open src/index.ts"],
    readsWorkspace: true,
    untrustedOutput: {
      sourceType: "filesystem",
      sourceName: "workspace file contents",
      notes: "File contents can contain arbitrary prompt-injection text.",
    },
  }),

  // -------------------------------------------------------------------------
  // write_file
  // -------------------------------------------------------------------------
  defineFunction({
    name: "write_file",
    description:
      "Write or append text to a file. Creates parent directories when needed.",
    input: writeFileSchema,
    handler: async (input, fnCtx) => fnCtx.services.filesystem.write(input),
    auth: FS_AUTH,
    domains: FS_DOMAINS,
    agentScopes: FS_SCOPES,
    defaultVisibleScopes: ["coding-worker"],
    examples: ["create notes.md", "overwrite config file"],
    mutatesState: true,
  }),

  // -------------------------------------------------------------------------
  // edit_file
  // -------------------------------------------------------------------------
  defineFunction({
    name: "edit_file",
    description:
      "Replace text in a file using an exact oldString -> newString edit. Errors if the match is missing or ambiguous.",
    input: editFileSchema,
    handler: async (input, fnCtx) => fnCtx.services.filesystem.edit(input),
    auth: FS_AUTH,
    domains: FS_DOMAINS,
    agentScopes: FS_SCOPES,
    defaultVisibleScopes: ["coding-worker"],
    examples: ["replace one string", "patch a small file"],
    mutatesState: true,
  }),

  // -------------------------------------------------------------------------
  // apply_patch
  // -------------------------------------------------------------------------
  defineFunction({
    name: "apply_patch",
    description:
      "Apply a structured multi-file patch with add, update, move, and delete operations. Prefer this for diff-shaped edits instead of full rewrites.",
    input: applyPatchSchema,
    handler: async (input, fnCtx) => fnCtx.services.filesystem.applyPatch(input),
    auth: FS_AUTH,
    domains: FS_DOMAINS,
    agentScopes: FS_SCOPES,
    defaultVisibleScopes: ["coding-worker"],
    examples: ["apply a structured patch", "update multiple files with a patch"],
    mutatesState: true,
  }),

  // -------------------------------------------------------------------------
  // list_dir
  // -------------------------------------------------------------------------
  defineFunction({
    name: "list_dir",
    description:
      "List directory contents. Supports recursive listing, result limits, and format=json for structured output.",
    input: listDirSchema,
    handler: async (input, fnCtx) => fnCtx.services.filesystem.listDir(input),
    auth: FS_AUTH,
    domains: FS_DOMAINS,
    agentScopes: FS_SCOPES,
    defaultVisibleScopes: ["coding-planner", "coding-worker"],
    examples: ["list src recursively", "show project files"],
    readsWorkspace: true,
    untrustedOutput: {
      sourceType: "filesystem",
      sourceName: "workspace directory listing",
      notes: "Filenames and directory names are untrusted input.",
    },
  }),

  // -------------------------------------------------------------------------
  // glob
  // -------------------------------------------------------------------------
  defineFunction({
    name: "glob",
    description: "Find paths matching a glob pattern under a directory.",
    input: globSchema,
    handler: async (input, fnCtx) => fnCtx.services.filesystem.glob(input),
    auth: FS_AUTH,
    domains: FS_DOMAINS,
    agentScopes: FS_SCOPES,
    defaultVisibleScopes: ["coding-planner", "coding-worker"],
    examples: ["find all *.test.ts", "match docs/**/*.md"],
    readsWorkspace: true,
    untrustedOutput: {
      sourceType: "filesystem",
      sourceName: "workspace glob matches",
      notes: "Matched paths are untrusted input.",
    },
  }),

  // -------------------------------------------------------------------------
  // grep
  // -------------------------------------------------------------------------
  defineFunction({
    name: "grep",
    description:
      "Search file contents with ripgrep. Returns matching file paths, line numbers, and lines.",
    input: grepSchema,
    handler: async (input, fnCtx) => fnCtx.services.filesystem.grep(input),
    auth: FS_AUTH,
    domains: FS_DOMAINS,
    agentScopes: FS_SCOPES,
    defaultVisibleScopes: ["coding-planner", "coding-worker"],
    examples: ["search for load_tool_library", "find TODO lines"],
    readsWorkspace: true,
    untrustedOutput: {
      sourceType: "filesystem",
      sourceName: "workspace grep results",
      notes: "Matched file contents are untrusted input.",
    },
  }),

  // -------------------------------------------------------------------------
  // stat_path
  // -------------------------------------------------------------------------
  defineFunction({
    name: "stat_path",
    description: "Show metadata for a file or directory path. Supports format=json for structured output.",
    input: statPathSchema,
    handler: async (input, fnCtx) => fnCtx.services.filesystem.statPath(input),
    auth: FS_AUTH,
    domains: FS_DOMAINS,
    agentScopes: FS_SCOPES,
    defaultVisibleScopes: ["coding-planner", "coding-worker"],
    examples: ["check file size", "inspect path metadata"],
    readsWorkspace: true,
    untrustedOutput: {
      sourceType: "filesystem",
      sourceName: "workspace path metadata",
      notes: "Path names are untrusted input.",
    },
  }),

  // -------------------------------------------------------------------------
  // mkdir
  // -------------------------------------------------------------------------
  defineFunction({
    name: "mkdir",
    description: "Create a directory.",
    input: mkdirSchema,
    handler: async (input, fnCtx) => fnCtx.services.filesystem.mkdir(input),
    auth: FS_AUTH,
    domains: FS_DOMAINS,
    agentScopes: FS_SCOPES,
    defaultVisibleScopes: ["coding-worker"],
    examples: ["create tmp/output", "make nested folders"],
    mutatesState: true,
  }),

  // -------------------------------------------------------------------------
  // move_path
  // -------------------------------------------------------------------------
  defineFunction({
    name: "move_path",
    description: "Move or rename a file or directory.",
    input: copyMoveSchema,
    handler: async (input, fnCtx) => fnCtx.services.filesystem.movePath(input),
    auth: FS_AUTH,
    domains: FS_DOMAINS,
    agentScopes: FS_SCOPES,
    defaultVisibleScopes: ["coding-worker"],
    examples: ["rename config file", "move a folder"],
    mutatesState: true,
  }),

  // -------------------------------------------------------------------------
  // copy_path
  // -------------------------------------------------------------------------
  defineFunction({
    name: "copy_path",
    description: "Copy a file or directory.",
    input: copyMoveSchema,
    handler: async (input, fnCtx) => fnCtx.services.filesystem.copyPath(input),
    auth: FS_AUTH,
    domains: FS_DOMAINS,
    agentScopes: FS_SCOPES,
    defaultVisibleScopes: ["coding-worker"],
    examples: ["copy template file", "duplicate a directory"],
    mutatesState: true,
  }),

  // -------------------------------------------------------------------------
  // delete_path
  // -------------------------------------------------------------------------
  defineFunction({
    name: "delete_path",
    description: "Delete a file or directory.",
    input: deletePathSchema,
    handler: async (input, fnCtx) => fnCtx.services.filesystem.deletePath(input),
    auth: FS_AUTH,
    domains: FS_DOMAINS,
    agentScopes: FS_SCOPES,
    defaultVisibleScopes: ["coding-worker"],
    examples: ["remove temp file", "delete old artifacts"],
    mutatesState: true,
  }),
];
