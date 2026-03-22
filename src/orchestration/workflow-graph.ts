import { getExecutionBatch, isPlanComplete } from "../domain/task-plan";
import type { WorkflowRun } from "../domain/workflow-run";
import { telemetry } from "../services/telemetry";
import { createTraceSpan } from "../utils/telemetry-helpers";
import { timestamp } from "../utils/timestamp";
import {
  WorkflowCancelledError,
  WorkflowHardTimeoutError,
  WorkflowResumableInterruptionError,
} from "./workflow-types";
import { createTimeoutContext } from "./workflow-timeout";
import {
  buildFinishedRun,
  buildTimedOutRun,
  buildHardTimedOutRun,
  buildCancelledRun,
  buildResumableInterruptionRun,
  buildExceededTaskErrorThresholdRun,
  executeTaskPlanBatch,
  getMaxConsecutiveTaskErrors,
  persistRun,
} from "./workflow-state";
import { planCodingRun } from "./workflow-planner";
import { executeCodingBatch } from "./workflow-executor";

// Re-export public API
export type { WorkflowExecutionDeps } from "./workflow-types";
export { pruneWorkflowToolMessages } from "./workflow-state";

const workflowTelemetry = telemetry.child({ component: "workflow" });
const traceSpan = createTraceSpan(workflowTelemetry);

export async function executeWorkflowRun(
  run: WorkflowRun,
  deps: import("./workflow-types").WorkflowExecutionDeps,
): Promise<WorkflowRun> {
  return traceSpan(
    "workflow.execute_run",
    async () => {
      const timeout = createTimeoutContext(run);
      let nextRun: WorkflowRun = {
        ...run,
        status: "running",
        runningState: "active",
        executionStartedAt: run.executionStartedAt ?? timestamp(),
        nextAttemptAt: undefined,
        updatedAt: timestamp(),
      };
      try {
        await persistRun(nextRun, deps.onRunUpdate);

        if (nextRun.kind === "coding-agent" && !nextRun.plan) {
          nextRun = {
            ...nextRun,
            currentSessionId: `${nextRun.id}:plan`,
            currentTaskId: undefined,
            updatedAt: timestamp(),
          };
          await persistRun(nextRun, deps.onRunUpdate);
          const planned = await planCodingRun(nextRun, deps, timeout);
          if (planned.kind === "timed_out") {
            return persistRun(buildTimedOutRun(planned.run, planned.summary), deps.onRunUpdate);
          }

          nextRun = planned.run;
          await persistRun(nextRun, deps.onRunUpdate);
        }

        while (nextRun.plan && getExecutionBatch(nextRun.plan).mode !== "idle" && !isPlanComplete(nextRun.plan)) {
          if (nextRun.kind === "coding-agent") {
            const batch = getExecutionBatch(nextRun.plan);
            nextRun = {
              ...nextRun,
              currentSessionId: batch.tasks.length === 1 ? `${nextRun.id}:${batch.tasks[0]!.id}` : undefined,
              currentTaskId: batch.tasks.length === 1 ? batch.tasks[0]!.id : undefined,
              updatedAt: timestamp(),
            };
            await persistRun(nextRun, deps.onRunUpdate);
            const batchResult = await executeCodingBatch(nextRun, deps, timeout);
            nextRun = batchResult.run;
            await persistRun(nextRun, deps.onRunUpdate);
            if (batchResult.kind === "timed_out") {
              return persistRun(buildTimedOutRun(nextRun, batchResult.summary), deps.onRunUpdate);
            }
            if ((nextRun.consecutiveTaskErrorCount ?? 0) >= getMaxConsecutiveTaskErrors()) {
              return persistRun(buildExceededTaskErrorThresholdRun(nextRun), deps.onRunUpdate);
            }
            continue;
          }

          nextRun = executeTaskPlanBatch(nextRun);
          await persistRun(nextRun, deps.onRunUpdate);
        }
      } catch (error) {
        if (error instanceof WorkflowCancelledError) {
          return persistRun(buildCancelledRun(nextRun), deps.onRunUpdate);
        }
        if (error instanceof WorkflowHardTimeoutError) {
          return persistRun(buildHardTimedOutRun(nextRun, error), deps.onRunUpdate);
        }
        if (error instanceof WorkflowResumableInterruptionError) {
          return persistRun(buildResumableInterruptionRun(nextRun, error), deps.onRunUpdate);
        }
        throw error;
      }

      const finished = buildFinishedRun({
        ...nextRun,
        currentSessionId: undefined,
        currentTaskId: undefined,
      });
      if (finished.status === "completed" || finished.status === "failed" || finished.status === "cancelled") {
        deps.workflowSessions.clearRun(finished.id);
      }
      return persistRun(finished, deps.onRunUpdate);
    },
    {
      attributes: {
        runId: run.id,
        kind: run.kind,
        profileId: run.profileId,
        launchDepth: run.launchDepth,
        originConversationKey: run.originConversationKey,
        workspaceCwd: run.workspaceCwd,
        resumed: Boolean(run.executionStartedAt),
      },
    },
  );
}
