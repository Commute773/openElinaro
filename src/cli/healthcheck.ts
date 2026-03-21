import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_AGENT_HEALTHCHECK_TIMEOUT_MS,
  ensureAgentHealthcheckDirs,
  resolveAgentHealthcheckPaths,
  type AgentHealthcheckRequest,
  type AgentHealthcheckResponse,
} from "../services/agent-healthcheck-service";

function parseTimeoutMs(argv: string[]) {
  const timeoutArg = argv.find((entry) => entry.startsWith("--timeout-ms="));
  if (!timeoutArg) {
    return DEFAULT_AGENT_HEALTHCHECK_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(timeoutArg.slice("--timeout-ms=".length), 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    throw new Error(`Invalid --timeout-ms value: ${timeoutArg}`);
  }
  return parsed;
}

function nowIso() {
  return new Date().toISOString();
}

function nextRequestId() {
  return `healthcheck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function waitForResponse(filePath: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as AgentHealthcheckResponse;
    }
    await Bun.sleep(250);
  }
  return null;
}

const timeoutMs = parseTimeoutMs(process.argv.slice(2));
const paths = resolveAgentHealthcheckPaths();
ensureAgentHealthcheckDirs(paths);

const request: AgentHealthcheckRequest = {
  id: nextRequestId(),
  createdAt: nowIso(),
  timeoutMs,
};

const requestPath = path.join(paths.requestsDir, `${request.id}.json`);
const responsePath = path.join(paths.responsesDir, `${request.id}.json`);
fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);

const response = await waitForResponse(responsePath, timeoutMs + 5_000);
if (!response) {
  fs.rmSync(requestPath, { force: true });
  console.error(`Healthcheck timed out after ${timeoutMs}ms without a response file.`);
  process.exit(1);
}

const lines = [
  `Healthcheck id: ${response.id}`,
  `Status: ${response.status}`,
  `Conversation: ${response.conversationKey}`,
  `Completed: ${response.completedAt}`,
  response.immediateMessage ? `Immediate: ${response.immediateMessage}` : "",
  response.backgroundMessage ? `Background: ${response.backgroundMessage}` : "",
  response.error ? `Error: ${response.error}` : "",
].filter(Boolean);

console.log(lines.join("\n"));
process.exit(response.status === "ok" ? 0 : 1);
