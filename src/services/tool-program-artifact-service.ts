import fs from "node:fs";
import path from "node:path";
import { resolveRuntimePath } from "./runtime-root";

const TOOL_PROGRAM_ARTIFACT_ROOT = resolveRuntimePath("tool-program-artifacts");

export interface ToolProgramArtifactRecord {
  path: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
}

function sanitizeFileName(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "artifact";
}

function serializeContent(content: unknown) {
  if (typeof content === "string") {
    return content;
  }
  return `${JSON.stringify(content, null, 2)}\n`;
}

export class ToolProgramArtifactService {
  createRunDirectory(runId: string) {
    const dir = path.join(TOOL_PROGRAM_ARTIFACT_ROOT, runId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeArtifact(params: {
    runId: string;
    name: string;
    content: unknown;
    mediaType?: string;
  }): ToolProgramArtifactRecord {
    const runDir = this.createRunDirectory(params.runId);
    const fileName = sanitizeFileName(params.name);
    const filePath = path.join(runDir, fileName);
    const serialized = serializeContent(params.content);
    fs.writeFileSync(filePath, serialized, "utf8");

    return {
      path: filePath,
      fileName,
      mediaType: params.mediaType ?? "text/plain",
      byteLength: Buffer.byteLength(serialized),
    };
  }
}
