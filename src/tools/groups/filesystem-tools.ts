import { type StructuredToolInterface } from "@langchain/core/tools";
import { defineTool } from "../define-tool";
import { z } from "zod";
import type { ToolBuildContext } from "./tool-group-types";

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

export function buildFilesystemTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  return [
    defineTool(async (input) => ctx.filesystem.read(input), {
      name: "read_file",
      description:
        "Read a file or directory. File reads return numbered lines. Directory reads return entries. Supports offset and limit for paging.",
      schema: readFileSchema,
    }),
    defineTool(async (input) => ctx.filesystem.write(input), {
      name: "write_file",
      description:
        "Write or append text to a file. Creates parent directories when needed.",
      schema: writeFileSchema,
    }),
    defineTool(async (input) => ctx.filesystem.edit(input), {
      name: "edit_file",
      description:
        "Replace text in a file using an exact oldString -> newString edit. Errors if the match is missing or ambiguous.",
      schema: editFileSchema,
    }),
    defineTool(async (input) => ctx.filesystem.applyPatch(input), {
      name: "apply_patch",
      description:
        "Apply a structured multi-file patch with add, update, move, and delete operations. Prefer this for diff-shaped edits instead of full rewrites.",
      schema: applyPatchSchema,
    }),
    defineTool(async (input) => ctx.filesystem.listDir(input), {
      name: "list_dir",
      description:
        "List directory contents. Supports recursive listing, result limits, and format=json for structured output.",
      schema: listDirSchema,
    }),
    defineTool(async (input) => ctx.filesystem.glob(input), {
      name: "glob",
      description: "Find paths matching a glob pattern under a directory.",
      schema: globSchema,
    }),
    defineTool(async (input) => ctx.filesystem.grep(input), {
      name: "grep",
      description:
        "Search file contents with ripgrep. Returns matching file paths, line numbers, and lines.",
      schema: grepSchema,
    }),
    defineTool(async (input) => ctx.filesystem.statPath(input), {
      name: "stat_path",
      description: "Show metadata for a file or directory path. Supports format=json for structured output.",
      schema: statPathSchema,
    }),
    defineTool(async (input) => ctx.filesystem.mkdir(input), {
      name: "mkdir",
      description: "Create a directory.",
      schema: mkdirSchema,
    }),
    defineTool(async (input) => ctx.filesystem.movePath(input), {
      name: "move_path",
      description: "Move or rename a file or directory.",
      schema: copyMoveSchema,
    }),
    defineTool(async (input) => ctx.filesystem.copyPath(input), {
      name: "copy_path",
      description: "Copy a file or directory.",
      schema: copyMoveSchema,
    }),
    defineTool(async (input) => ctx.filesystem.deletePath(input), {
      name: "delete_path",
      description: "Delete a file or directory.",
      schema: deletePathSchema,
    }),
  ];
}
