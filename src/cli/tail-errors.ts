#!/usr/bin/env bun
import fs from "node:fs";
import { resolveRuntimePath } from "../services/runtime-root";

const logPath = resolveRuntimePath("logs", "errors.jsonl");

const args = process.argv.slice(2);
const follow = args.includes("-f") || args.includes("--follow");
const jsonMode = args.includes("--json");
const componentFilter = args
  .find((a) => a.startsWith("--component="))
  ?.split("=")[1];
const levelFilter = args.find((a) => a.startsWith("--level="))?.split("=")[1];

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: bun src/cli/tail-errors.ts [options]

Options:
  -f, --follow           Follow the log file for new entries
  --component=<name>     Filter by component (e.g., discord, agent_chat)
  --level=<level>        Filter by level (error, warn)
  --json                 Output raw JSONL (for piping to jq)
  -h, --help             Show this help

Examples:
  bun src/cli/tail-errors.ts                          Show recent errors
  bun src/cli/tail-errors.ts -f                       Follow mode
  bun src/cli/tail-errors.ts --component=discord      Discord errors only
  bun src/cli/tail-errors.ts -f --json | jq .         Follow with jq formatting
  tail -f ~/.openelinaro/logs/errors.jsonl | jq .     Also works directly`);
  process.exit(0);
}

if (!fs.existsSync(logPath)) {
  console.error(`No error log found at ${logPath}`);
  console.error(
    "The error log is created when the service starts and errors occur.",
  );
  process.exit(1);
}

function matchesFilter(parsed: Record<string, unknown>): boolean {
  if (componentFilter && parsed.component !== componentFilter) return false;
  if (levelFilter && parsed.level !== levelFilter) return false;
  return true;
}

function formatEntry(parsed: Record<string, unknown>): string {
  const ts = parsed.ts ?? parsed.timestamp ?? "";
  const level = parsed.level ?? "error";
  const component = parsed.component ?? "unknown";
  const event = parsed.event ?? parsed.operation ?? "";
  const message = parsed.message ?? parsed.msg ?? "";
  const traceId = parsed.traceId ?? parsed.trace;
  const conversationKey = parsed.conversationKey ?? parsed.conversation;

  const lines: string[] = [];
  lines.push(`${ts} [${level}] ${component} :: ${event}`);
  if (message) lines.push(`  ${message}`);
  const meta: string[] = [];
  if (traceId) meta.push(`trace=${traceId}`);
  if (conversationKey) meta.push(`conversation=${conversationKey}`);
  if (meta.length > 0) lines.push(`  ${meta.join(" ")}`);
  return lines.join("\n");
}

function processLine(line: string): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!matchesFilter(parsed)) return;
  if (jsonMode) {
    console.log(line);
  } else {
    console.log(formatEntry(parsed));
  }
}

const content = fs.readFileSync(logPath, "utf8");
const allLines = content.split("\n").filter(Boolean);
const tail = allLines.slice(-50);
for (const line of tail) {
  processLine(line);
}

if (follow) {
  let position = fs.statSync(logPath).size;
  console.log("--- following ---");
  fs.watchFile(logPath, { interval: 500 }, () => {
    const stat = fs.statSync(logPath);
    if (stat.size < position) {
      // File was rotated
      position = 0;
    }
    if (stat.size > position) {
      const fd = fs.openSync(logPath, "r");
      const buffer = Buffer.alloc(stat.size - position);
      fs.readSync(fd, buffer, 0, buffer.length, position);
      fs.closeSync(fd);
      position = stat.size;
      const newLines = buffer.toString("utf8").split("\n").filter(Boolean);
      for (const line of newLines) {
        processLine(line);
      }
    }
  });
}
