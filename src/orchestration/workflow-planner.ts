import { HumanMessage } from "@langchain/core/messages";
import type { WorkflowRun } from "../domain/workflow-run";
import { toToolSet } from "../services/ai-sdk-message-service";
import { timestamp } from "../utils/timestamp";
import type { TimeoutContext, PlanningOutcome, SubmittedPlan, WorkflowExecutionDeps } from "./workflow-types";
import { submittedPlanSchema, MAX_PLANNED_TASKS } from "./workflow-types";
import { buildWorkflowTimeAwarenessBlock } from "./workflow-timeout";
import {
  buildTaskPlan,
  appendUniqueLogEntries,
  getWorkspaceCwd,
  buildPlannerResumeContext,
  pruneWorkflowToolMessages,
} from "./workflow-state";
import {
  runStructuredToolAgent,
  ensureWorkflowSession,
  buildWorkflowAgentSystemPrompt,
  isWorkflowReasonToolEnabled,
} from "./workflow-agent-runner";
import type { AppProgressEvent } from "../domain/assistant";

export async function planCodingRun(
  run: WorkflowRun,
  deps: WorkflowExecutionDeps,
  timeout: TimeoutContext,
): Promise<PlanningOutcome> {
  const workspaceCwd = getWorkspaceCwd(run);
  const plannerSessionKey = `${run.id}:plan`;
  const resumeContext = buildPlannerResumeContext(run);
  const userPrompt = [
    `Goal: ${run.goal}`,
    `Workspace cwd: ${workspaceCwd}`,
    buildWorkflowTimeAwarenessBlock(timeout),
    resumeContext ? `Existing run context:\n${resumeContext}` : "",
    "Plan the work, include acceptance criteria, and list concrete verification commands for tasks that modify code.",
    "Assume this is a real autonomous coding run: gather context, keep the plan execution-ready, and avoid placeholder tasks.",
  ]
    .filter(Boolean)
    .join("\n\n");
  deps.workflowSessions.ensure({
    key: plannerSessionKey,
    runId: run.id,
    scope: "planner",
    messages: [new HumanMessage(userPrompt)],
  });
  const recordProgress = async (event: AppProgressEvent) => {
    const message = typeof event === "string" ? event : event.message;
    deps.workflowSessions.appendProgress(plannerSessionKey, `[plan] ${message}`);
  };
  const activatedToolNames = new Set(
    deps.workflowSessions.get(plannerSessionKey)?.activeToolNames ?? [],
  );
  const context = {
    conversationKey: plannerSessionKey,
    onToolUse: recordProgress,
    invocationSource: "direct" as const,
    getActiveToolNames: () => [...activatedToolNames],
    activateToolNames: (toolNames: string[]) => {
      for (const name of toolNames) {
        activatedToolNames.add(name);
      }
      deps.workflowSessions.addActiveTools(plannerSessionKey, toolNames);
    },
  };
  const allTools = toToolSet(
    deps.toolResolver.resolveAllForCodingPlanner({
      context,
      defaultCwd: workspaceCwd,
    }).entries,
  );
  const submittedPlan = await runStructuredToolAgent<SubmittedPlan>(
    {
      connector: deps.connector,
      allTools,
      getActiveTools: () =>
        deps.toolResolver.resolveForCodingPlanner({
          activatedToolNames: [...activatedToolNames],
          context,
          defaultCwd: workspaceCwd,
        }).tools,
      sessionId: plannerSessionKey,
      sessionStore: deps.workflowSessions,
      sessionScope: "planner",
      runId: run.id,
      retryCount: run.retryCount,
      timeout,
      abortSignal: deps.abortSignal,
      systemPrompt: buildWorkflowAgentSystemPrompt({
        baseSystemPrompt: deps.baseSystemPrompt,
        assistantContext: deps.assistantContext,
        run,
        timeout,
        role: "planner",
        roleInstructions: [
          "You are a background coding planner.",
          "Inspect the repository before planning. Use the available tools to understand the codebase, constraints, and validation commands.",
          "Use the currently visible tools first. Call load_tool_library only when the needed tool family is not already visible.",
          ...(isWorkflowReasonToolEnabled()
            ? ["In this test-mode run, include report_progress immediately before non-submission tool calls when practical, ideally in the same response. Do not spend extra turns only to satisfy observability."]
            : []),
          "If repository inspection turns into repeated searches, reads, or filtering, use run_tool_program so intermediate results stay out of model context.",
          "Treat the timeout as real wall-clock budget, not turn count. Re-check the remaining time from the prompt before starting another broad scan or deep loop.",
          "Produce a compact execution plan that advances the user's goal in the current workspace.",
          "Use serial tasks for anything that edits shared files or depends on the output of prior tasks.",
          "Use parallel tasks only for independent read-only analysis or verification work.",
          `Keep the plan to at most ${MAX_PLANNED_TASKS} tasks.`,
          "End by calling report_plan. Do not answer in plain text instead of the tool.",
        ],
      }),
      userPrompt,
      submissionToolName: "report_plan",
      submissionToolDescription:
        "Submit the execution plan after repository inspection. This is required to continue the workflow.",
      submissionSchema: submittedPlanSchema,
      timeoutSummaryPrompt: (session) => [
        `Goal: ${run.goal}`,
        `Workspace cwd: ${workspaceCwd}`,
        session.progressLog.length > 0
          ? `Tool activity before timeout:\n- ${session.progressLog.join("\n- ")}`
          : "Tool activity before timeout: none recorded.",
        "You have reached the workflow timeout.",
        "Summarize what you learned, what work is still unfinished, and the most useful next step for the parent agent.",
      ].join("\n\n"),
    },
    pruneWorkflowToolMessages,
  );

  const plannerSession = deps.workflowSessions.get(plannerSessionKey);
  const runWithProgress = plannerSession && plannerSession.progressLog.length > 0
    ? {
        ...run,
        executionLog: appendUniqueLogEntries(run.executionLog, plannerSession.progressLog),
      }
    : run;

  if (submittedPlan.kind === "timed_out") {
    return {
      kind: "timed_out",
      run: {
        ...runWithProgress,
        updatedAt: timestamp(),
      },
      summary: submittedPlan.summary,
    };
  }

  const plan = buildTaskPlan(run.goal, submittedPlan.value);
  return {
    kind: "planned",
    run: {
      ...run,
      plan,
      updatedAt: timestamp(),
      currentSessionId: plannerSessionKey,
      pendingParentInstructions: undefined,
      resultSummary: submittedPlan.value.summary,
      executionLog: appendUniqueLogEntries(run.executionLog, [
        ...(plannerSession?.progressLog ?? []),
        `Planned coding run with ${plan.tasks.length} tasks.`,
        `Plan summary: ${submittedPlan.value.summary}`,
      ]),
    },
  };
}
