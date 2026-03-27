import { mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";
import { timestamp } from "../utils/timestamp";
import { countLines } from "../utils/text-utils";

export interface StoredToolResultRecord {
  ref: string;
  namespace: string;
  toolCallId: string;
  toolName: string;
  status: "success" | "error";
  content: string;
  charLength: number;
  lineCount: number;
  createdAt: string;
}

function sanitizeSegment(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "default";
}


function nextRef(namespace: string, toolCallId: string) {
  return [
    "toolres",
    sanitizeSegment(namespace).slice(0, 40),
    sanitizeSegment(toolCallId).slice(0, 40),
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 8),
  ].join("_");
}

export class ToolResultStore {
  constructor(private readonly rootDir = resolveRuntimePath("tool-results")) {}

  async save(params: {
    namespace: string;
    toolCallId: string;
    toolName: string;
    status: "success" | "error";
    content: string;
  }): Promise<StoredToolResultRecord> {
    assertTestRuntimeRootIsIsolated("Tool result store");
    await mkdir(this.rootDir, { recursive: true });
    const ref = nextRef(params.namespace, params.toolCallId);
    const record: StoredToolResultRecord = {
      ref,
      namespace: params.namespace,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      status: params.status,
      content: params.content,
      charLength: params.content.length,
      lineCount: countLines(params.content),
      createdAt: timestamp(),
    };
    const filePath = path.join(this.rootDir, `${ref}.json`);
    await Bun.write(filePath, `${JSON.stringify(record, null, 2)}\n`);
    await chmod(filePath, 0o600);
    return record;
  }

  async get(ref: string): Promise<StoredToolResultRecord | undefined> {
    const recordPath = path.join(this.rootDir, `${ref}.json`);
    if (!(await Bun.file(recordPath).exists())) {
      return undefined;
    }
    return JSON.parse(await Bun.file(recordPath).text()) as StoredToolResultRecord;
  }
}
