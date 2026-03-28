import type { SubagentRun } from "../domain/subagent-run";
import type { ModelService } from "./models/model-service";
import type { SubagentController } from "../app/runtime-subagent";

function buildFallbackSummaryContext(run: SubagentRun) {
  const eventLog = run.eventLog.length > 0
    ? run.eventLog
        .slice(-12)
        .map((event) => `${event.timestamp} ${event.kind}${event.summary ? `: ${event.summary}` : ""}`)
        .join("\n")
    : "(no recorded events)";

  return [
    `Run id: ${run.id}`,
    `Status: ${run.status}`,
    `Provider: ${run.provider}`,
    `Goal: ${run.goal}`,
    run.resultSummary ? `Result summary: ${run.resultSummary}` : "",
    run.error ? `Error: ${run.error}` : "",
    "Recent event log:",
    eventLog,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function summarizeAgentRun(params: {
  runId: string;
  subagents: Pick<SubagentController, "getAgentRun" | "readAgentTerminal">;
  models: Pick<ModelService, "summarizeToolResult">;
}) {
  const run = params.subagents.getAgentRun(params.runId);
  if (!run) {
    return `No agent run found for ${params.runId}.`;
  }

  const terminal = (await params.subagents.readAgentTerminal(params.runId)).trim();
  const hasTerminal = terminal.length > 0 && terminal !== "(tmux window no longer exists)";
  const output = hasTerminal
    ? terminal
    : buildFallbackSummaryContext(run);

  return params.models.summarizeToolResult({
    toolName: "agent_summary",
    goal: "Summarize what the agent is doing now or why it stopped. Mention concrete errors, completion state, and likely next action when the evidence supports it.",
    output,
  });
}
