import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDiscordResponse, sanitizeDiscordText, ATTACHMENT_FAILED_PREFIX } from "./discord-response-service";
import type { AppResponse } from "../domain/assistant";

const baseResponse = (message: string): AppResponse => ({
  requestId: "test",
  mode: "immediate",
  message,
  warnings: [],
});

const noopAssertPathAccess = (p: string) => p;

let tmpDir: string;
let tmpFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-test-"));
  tmpFile = path.join(tmpDir, "test-file.txt");
  fs.writeFileSync(tmpFile, "hello world");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("parses double-quoted path attribute", () => {
  const result = resolveDiscordResponse({
    response: baseResponse(`Here's the file. <discord-file path="${tmpFile}" />`),
    assertPathAccess: noopAssertPathAccess,
  });
  expect(result.attachments).toHaveLength(1);
  expect(result.attachments![0]!.path).toBe(tmpFile);
});

test("parses single-quoted path attribute", () => {
  const result = resolveDiscordResponse({
    response: baseResponse(`Here's the file. <discord-file path='${tmpFile}' />`),
    assertPathAccess: noopAssertPathAccess,
  });
  expect(result.attachments).toHaveLength(1);
  expect(result.attachments![0]!.path).toBe(tmpFile);
});

test("parses unquoted path attribute", () => {
  const result = resolveDiscordResponse({
    response: baseResponse(`Here's the file. <discord-file path=${tmpFile} />`),
    assertPathAccess: noopAssertPathAccess,
  });
  expect(result.attachments).toHaveLength(1);
  expect(result.attachments![0]!.path).toBe(tmpFile);
});

test("warns when directive has no path attribute", () => {
  const result = resolveDiscordResponse({
    response: baseResponse(`Here it is. <discord-file name="report.txt" />`),
    assertPathAccess: noopAssertPathAccess,
  });
  expect(result.attachments).toHaveLength(0);
  expect(result.warnings?.some((w) => w.includes("did not include a path"))).toBe(true);
});

test("warns when file does not exist", () => {
  const result = resolveDiscordResponse({
    response: baseResponse(`<discord-file path="/nonexistent/file.txt" />`),
    assertPathAccess: noopAssertPathAccess,
  });
  expect(result.attachments).toHaveLength(0);
  expect(result.warnings?.some((w) => w.includes("not found"))).toBe(true);
});

test("sanitizeDiscordText strips file directives", () => {
  const text = `Hello\n<discord-file path="/foo.txt" />\nWorld`;
  expect(sanitizeDiscordText(text)).toBe("Hello\n\nWorld");
});
