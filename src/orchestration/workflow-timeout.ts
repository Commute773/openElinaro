import type { WorkflowRun } from "../domain/workflow-run";
import { getRuntimeConfig } from "../config/runtime-config";
import {
  WORKFLOW_DEFAULT_HARD_TIMEOUT_GRACE_MS as DEFAULT_HARD_TIMEOUT_GRACE_MS,
} from "../config/service-constants";
import { buildCurrentLocalTimePrefix } from "../services/local-time-service";
import {
  type TimeoutContext,
  WorkflowTimeoutError,
  WorkflowHardTimeoutError,
  WorkflowCancelledError,
  WorkflowResumableInterruptionError,
  TIMEOUT_SUMMARY_RESERVE_MS,
  MIN_TIMEOUT_SUMMARY_BUDGET_MS,
  DEFAULT_RESUME_RETRY_DELAY_MS,
  MAX_RESUME_RETRY_DELAY_MS,
} from "./workflow-types";

export function getHardTimeoutGraceMs() {
  const override = getRuntimeConfig().core.app.workflow.hardTimeoutGraceMs;
  return Number.isFinite(override) && override >= 0 ? override : DEFAULT_HARD_TIMEOUT_GRACE_MS;
}

export function createTimeoutContext(run: WorkflowRun): TimeoutContext {
  const timeoutMs = run.timeoutMs ?? 3_600_000;
  const startedAtMs = run.executionStartedAt
    ? new Date(run.executionStartedAt).getTime()
    : Date.now();
  return {
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
    timeoutMs,
    hardTimeoutMs: timeoutMs + getHardTimeoutGraceMs(),
  };
}

export function getRemainingTimeoutMs(context: TimeoutContext) {
  return context.timeoutMs - (Date.now() - context.startedAtMs);
}

export function getRemainingHardTimeoutMs(context: TimeoutContext) {
  return context.hardTimeoutMs - (Date.now() - context.startedAtMs);
}

export function getTimeoutSummaryBudgetMs(context: TimeoutContext) {
  return Math.min(
    TIMEOUT_SUMMARY_RESERVE_MS,
    Math.max(MIN_TIMEOUT_SUMMARY_BUDGET_MS, Math.floor(context.timeoutMs * 0.2)),
  );
}

export function buildWorkflowTimeAwarenessBlock(context: TimeoutContext) {
  const now = new Date();
  return [
    buildCurrentLocalTimePrefix(now),
    `Workflow started at: ${new Date(context.startedAtMs).toISOString()}`,
    `Workflow soft timeout budget: ${context.timeoutMs}ms`,
    `Workflow soft time remaining right now: ${Math.max(0, getRemainingTimeoutMs(context))}ms`,
    `Workflow hard-stop remaining right now: ${Math.max(0, getRemainingHardTimeoutMs(context))}ms`,
    "Treat this as real wall-clock budget, not turn count. Re-check the remaining time before starting another broad search, edit loop, or verification pass.",
  ].join("\n");
}

export async function withWorkflowTimeout<T>(
  context: TimeoutContext,
  operation: (signal: AbortSignal) => Promise<T>,
  options?: {
    reserveMs?: number;
    externalSignal?: AbortSignal;
  },
) {
  const remainingMs = getRemainingTimeoutMs(context) - (options?.reserveMs ?? 0);
  const hardRemainingMs = getRemainingHardTimeoutMs(context);
  if (hardRemainingMs <= 0) {
    throw new WorkflowHardTimeoutError(context.timeoutMs, context.hardTimeoutMs);
  }
  if (remainingMs <= 0) {
    throw new WorkflowTimeoutError(context.timeoutMs);
  }

  const controller = new AbortController();
  let timedOut: "soft" | "hard" | null = null;
  let cancelled = options?.externalSignal?.aborted ?? false;
  const timeoutHandle = setTimeout(() => controller.abort(), remainingMs);
  let hardTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const abortFromExternal = () => {
    cancelled = true;
    controller.abort();
  };
  options?.externalSignal?.addEventListener("abort", abortFromExternal);
  const hardTimeoutPromise = new Promise<never>((_, reject) => {
    hardTimeoutHandle = setTimeout(() => {
      timedOut = "hard";
      controller.abort();
      reject(new WorkflowHardTimeoutError(context.timeoutMs, context.hardTimeoutMs));
    }, hardRemainingMs);
  });
  try {
    return await Promise.race([operation(controller.signal), hardTimeoutPromise]);
  } catch (error) {
    if (cancelled) {
      throw new WorkflowCancelledError();
    }
    if (timedOut === "hard") {
      throw new WorkflowHardTimeoutError(context.timeoutMs, context.hardTimeoutMs);
    }
    if (controller.signal.aborted) {
      timedOut = "soft";
      throw new WorkflowTimeoutError(context.timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    if (hardTimeoutHandle) {
      clearTimeout(hardTimeoutHandle);
    }
    options?.externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

export function getResumeRetryDelayMs(retryCount: number) {
  const baseDelayOverride = getRuntimeConfig().core.app.workflow.resumeRetryDelayMs;
  const baseDelayMs = Number.isFinite(baseDelayOverride) && baseDelayOverride >= 0
    ? baseDelayOverride
    : DEFAULT_RESUME_RETRY_DELAY_MS;
  return Math.min(
    MAX_RESUME_RETRY_DELAY_MS,
    baseDelayMs * Math.max(1, 2 ** Math.max(0, retryCount)),
  );
}

export function findNumericProperty(value: unknown, keys: string[]): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string") {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

export function getRetryAfterMs(error: unknown) {
  const responseHeaders = (() => {
    if (!error || typeof error !== "object") {
      return undefined;
    }
    const response = (error as { response?: { headers?: Headers | Map<string, string> | Record<string, string> } }).response;
    return response?.headers;
  })();
  const retryAfterValue = responseHeaders instanceof Headers
    ? responseHeaders.get("retry-after")
    : responseHeaders instanceof Map
      ? responseHeaders.get("retry-after")
      : responseHeaders && typeof responseHeaders === "object"
        ? responseHeaders["retry-after"]
        : undefined;

  if (typeof retryAfterValue === "string") {
    const seconds = Number(retryAfterValue);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1_000;
    }
  }

  const retryAfterSeconds = findNumericProperty(error, ["retryAfter", "retryAfterSeconds"]);
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1_000;
  }

  return undefined;
}

export function isWorkflowRateLimitError(error: unknown) {
  const status = findNumericProperty(error, ["statusCode", "status"])
    ?? findNumericProperty(
      error && typeof error === "object" ? (error as { response?: unknown }).response : undefined,
      ["statusCode", "status"],
    );
  if (status === 429) {
    return true;
  }

  const message = error instanceof Error
    ? `${error.name} ${error.message}`
    : String(error);
  return /\b(429|rate limit|too many requests)\b/i.test(message);
}

export function isResumableWorkflowInterruption(error: unknown) {
  if (error instanceof WorkflowTimeoutError || error instanceof WorkflowHardTimeoutError) {
    return false;
  }

  const message = error instanceof Error
    ? `${error.name} ${error.message}`
    : String(error);
  return /\b(aborted|offline|network|socket hang up|fetch failed|temporarily unavailable|econnreset|econnrefused|ehostunreach|enetunreach|provider unavailable|harness)\b/i.test(
    message,
  );
}
