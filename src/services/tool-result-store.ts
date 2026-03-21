import fs from "node:fs";
import path from "node:path";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";

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

function timestamp() {
  return new Date().toISOString();
}

function sanitizeSegment(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "default";
}

function countLines(content: string) {
  if (!content) {
    return 0;
  }
  return content.split(/\r?\n/).length;
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

  save(params: {
    namespace: string;
    toolCallId: string;
    toolName: string;
    status: "success" | "error";
    content: string;
  }): StoredToolResultRecord {
    assertTestRuntimeRootIsIsolated("Tool result store");
    fs.mkdirSync(this.rootDir, { recursive: true });
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
    fs.writeFileSync(
      path.join(this.rootDir, `${ref}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600 },
    );
    return record;
  }

  get(ref: string): StoredToolResultRecord | undefined {
    const recordPath = path.join(this.rootDir, `${ref}.json`);
    if (!fs.existsSync(recordPath)) {
      return undefined;
    }
    return JSON.parse(fs.readFileSync(recordPath, "utf8")) as StoredToolResultRecord;
  }
}
