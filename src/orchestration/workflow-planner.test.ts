import { describe, expect, test, mock } from "bun:test";
import type { WorkflowRun } from "../domain/workflow-run";
import type { WorkflowExecutionDeps, TimeoutContext } from "./workflow-types";
import { planCodingRun } from "./workflow-planner";

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-planner",
    kind: "coding-agent",
    goal: "Implement feature X",
    status: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    executionLog: [],
    ...overrides,
  };
}

const defaultTimeout: TimeoutContext = {
  startedAtMs: Date.now(),
  timeoutMs: 600_000,
  hardTimeoutMs: 900_000,
};

describe("planCodingRun", () => {
  test("propagates errors from the tool resolver", async () => {
    const deps = {
      connector: {} as any,
      toolResolver: {
        resolveAllForCodingPlanner: () => {
          throw new Error("Planner tool resolution failed");
        },
      } as any,
      shell: { execVerification: mock(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })) },
      workflowSessions: {
        ensure: mock(() => {}),
        get: mock(() => ({ progressLog: [], activeToolNames: [] })),
        appendProgress: mock(() => {}),
        addActiveTools: mock(() => {}),
      } as any,
      baseSystemPrompt: "test system prompt",
    } satisfies Partial<WorkflowExecutionDeps> as unknown as WorkflowExecutionDeps;

    const run = makeRun();

    await expect(planCodingRun(run, deps, defaultTimeout)).rejects.toThrow(
      "Planner tool resolution failed",
    );
  });

  test("sets up the planner session with the correct key", async () => {
    let capturedKey: string | undefined;
    const deps = {
      connector: {} as any,
      toolResolver: {
        resolveAllForCodingPlanner: () => {
          throw new Error("Stop after session setup");
        },
      } as any,
      shell: { execVerification: mock(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })) },
      workflowSessions: {
        ensure: mock((params: { key: string }) => {
          capturedKey = params.key;
        }),
        get: mock(() => ({ progressLog: [], activeToolNames: [] })),
        appendProgress: mock(() => {}),
        addActiveTools: mock(() => {}),
      } as any,
      baseSystemPrompt: "test",
    } satisfies Partial<WorkflowExecutionDeps> as unknown as WorkflowExecutionDeps;

    const run = makeRun({ id: "run-abc" });

    try {
      await planCodingRun(run, deps, defaultTimeout);
    } catch {
      // Expected — we throw in resolveAllForCodingPlanner
    }

    expect(capturedKey).toBe("run-abc:plan");
  });

  test("passes workspace cwd from the run", async () => {
    let capturedEnsureArgs: any;
    const deps = {
      connector: {} as any,
      toolResolver: {
        resolveAllForCodingPlanner: () => {
          throw new Error("Stop early");
        },
      } as any,
      shell: { execVerification: mock(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })) },
      workflowSessions: {
        ensure: mock((args: any) => { capturedEnsureArgs = args; }),
        get: mock(() => ({ progressLog: [], activeToolNames: [] })),
        appendProgress: mock(() => {}),
        addActiveTools: mock(() => {}),
      } as any,
      baseSystemPrompt: "test",
    } satisfies Partial<WorkflowExecutionDeps> as unknown as WorkflowExecutionDeps;

    const run = makeRun({ workspaceCwd: "/my/workspace" });

    try {
      await planCodingRun(run, deps, defaultTimeout);
    } catch {
      // Expected
    }

    // The session ensure should have been called with a message containing the workspace cwd
    expect(capturedEnsureArgs).toBeDefined();
    expect(capturedEnsureArgs.key).toBe("run-planner:plan");
    // The user prompt message should contain the workspace cwd
    const messageContent = capturedEnsureArgs.messages[0]?.content;
    expect(typeof messageContent === "string" && messageContent.includes("/my/workspace")).toBe(true);
  });

  test("includes resume context in user prompt when run has prior state", async () => {
    let capturedMessages: any;
    const deps = {
      connector: {} as any,
      toolResolver: {
        resolveAllForCodingPlanner: () => {
          throw new Error("Stop early");
        },
      } as any,
      shell: { execVerification: mock(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })) },
      workflowSessions: {
        ensure: mock((args: any) => { capturedMessages = args.messages; }),
        get: mock(() => ({ progressLog: [], activeToolNames: [] })),
        appendProgress: mock(() => {}),
        addActiveTools: mock(() => {}),
      } as any,
      baseSystemPrompt: "test",
    } satisfies Partial<WorkflowExecutionDeps> as unknown as WorkflowExecutionDeps;

    const run = makeRun({
      resultSummary: "Prior run failed on tests.",
      pendingParentInstructions: ["Focus on the failing test"],
    });

    try {
      await planCodingRun(run, deps, defaultTimeout);
    } catch {
      // Expected
    }

    const content = capturedMessages?.[0]?.content;
    expect(typeof content === "string" && content.includes("Prior run failed on tests.")).toBe(true);
    expect(typeof content === "string" && content.includes("Focus on the failing test")).toBe(true);
  });
});
