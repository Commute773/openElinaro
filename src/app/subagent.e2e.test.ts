import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildScriptedConnectorRequest,
  toGenerateResultFromAIMessage,
  type ScriptedConnectorRequest,
} from "../test/scripted-provider-connector";
import { updateTestRuntimeConfig } from "../test/runtime-config-test-helpers";

const repoRoot = process.cwd();

let previousCwd = "";
let tempRoot = "";

let appRuntimeModule: typeof import("./runtime");
let activeConnectorModule: typeof import("../connectors/active-model-connector");
let conversationStoreModule: typeof import("../services/conversation-store");
let memoryServiceModule: typeof import("../services/memory-service");
let modelServiceModule: typeof import("../services/model-service");

let originalDoGenerate: typeof activeConnectorModule.ActiveModelConnector.prototype.doGenerate;
let originalEnsureReady: typeof memoryServiceModule.MemoryService.prototype.ensureReady;
let originalInspectContextWindowUsage: typeof modelServiceModule.ModelService.prototype.inspectContextWindowUsage;
const scriptedRequests: ScriptedConnectorRequest[] = [];

function writeTestProfileRegistry() {
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".openelinarotest", "profiles/registry.json"),
    `${JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "root",
          name: "Root",
          roles: ["root"],
          memoryNamespace: "root",
          preferredProvider: "openai-codex",
          defaultModelId: "gpt-5.4",
          maxSubagentDepth: 1,
        },
        {
          id: "restricted",
          name: "Restricted",
          roles: ["restricted"],
          memoryNamespace: "restricted",
          shellUser: "restricted",
          preferredProvider: "claude",
          defaultModelId: "claude-opus-4-6",
          maxSubagentDepth: 1,
        },
      ],
    }, null, 2)}\n`,
  );
}

function writeTestProjectRegistry() {
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "projects"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".openelinarotest", "projects/registry.json"),
    `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`,
  );
}

function writeWorkspaceFixture() {
  fs.mkdirSync(path.join(tempRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "memory/documents/root"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "memory/documents/restricted"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "README.md"), "# subagent fixture\n", "utf8");
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ name: "subagent-fixture", type: "module" }, null, 2),
    "utf8",
  );
}

function copyDirectory(relativePath: string) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, relativePath), { recursive: true });
}

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function extractLatestHumanText(request: ScriptedConnectorRequest) {
  const latestHuman = [...request.messages]
    .reverse()
    .find((message): message is HumanMessage => message instanceof HumanMessage);
  if (!latestHuman) {
    return "";
  }
  return typeof latestHuman.content === "string"
    ? latestHuman.content
    : JSON.stringify(latestHuman.content);
}

function extractLatestTool(request: ScriptedConnectorRequest) {
  return [...request.messages]
    .reverse()
    .find((message): message is ToolMessage => message instanceof ToolMessage);
}

function scriptedWorkflowResponse(request: ScriptedConnectorRequest) {
  const workspaceRoot = tempRoot;
  const sessionId = request.sessionId ?? "";
  const latestTool = extractLatestTool(request);
  const latestHumanText = extractLatestHumanText(request);
  const timeoutScenario = latestHumanText.includes("Trigger the timeout handoff");
  const hardTimeoutScenario = latestHumanText.includes("Trigger the hard timeout handoff");
  const parentResumeScenario = latestHumanText.includes("Return after phase one so the parent can send the worker back");
  const followUpInstruction = "Go back and finish tasks 4 and 5. Only return when both are complete.";

  if (sessionId.endsWith(":plan")) {
    if (!latestTool) {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "plan-list-dir",
            name: "list_dir",
            args: {
              path: workspaceRoot,
              limit: 20,
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (latestTool.name === "list_dir") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "plan-submit",
            name: "report_plan",
            args: {
              summary: parentResumeScenario && latestHumanText.includes(followUpInstruction)
                ? "Tasks 1, 2, and 3 are already done. Plan only the remaining tasks 4 and 5."
                : hardTimeoutScenario
                ? `Workspace ${workspaceRoot} is readable by the restricted subagent and the hard-timeout handoff task is ready.`
                : timeoutScenario
                ? `Workspace ${workspaceRoot} is readable by the restricted subagent and the timeout handoff task is ready.`
                : `Workspace ${workspaceRoot} is readable by the restricted subagent.`,
              tasks: [
                {
                  id: parentResumeScenario && latestHumanText.includes(followUpInstruction)
                    ? "phase-two"
                    : hardTimeoutScenario ? "hard-timeout-test" : timeoutScenario ? "timeout-test" : "smoke-test",
                  title: parentResumeScenario && latestHumanText.includes(followUpInstruction)
                    ? "Finish tasks 4 and 5"
                    : hardTimeoutScenario
                    ? "Trigger hard timeout handoff"
                    : timeoutScenario
                      ? "Trigger timeout handoff"
                      : parentResumeScenario
                        ? "Complete phase one and return to the parent"
                      : "Verify workspace listing",
                  executionMode: "serial",
                  dependsOn: [],
                  acceptanceCriteria: parentResumeScenario && latestHumanText.includes(followUpInstruction)
                    ? ["Finish the remaining tasks 4 and 5 before returning."]
                    : hardTimeoutScenario
                    ? ["Stop work at timeout, then hard-time out if the handoff summary also hangs."]
                    : timeoutScenario
                    ? ["Stop work at timeout and provide a handoff summary."]
                    : parentResumeScenario
                      ? ["Complete phase one only, then return so the parent can decide what to do next."]
                    : ["List the workspace root successfully."],
                  verificationCommands: [],
                },
              ],
            },
            type: "tool_call",
          },
        ],
      });
    }
  }

  if (sessionId.endsWith(":phase-two")) {
    if (!latestTool) {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "phase-two-command",
            name: "exec_command",
            args: {
              command: "printf 'tasks 4 and 5 complete\\n' >/tmp/openelinaro-subagent-phase-two.txt",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (latestTool.name === "exec_command") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "phase-two-submit",
            name: "complete_coding_task",
            args: {
              status: "completed",
              summary: "Finished tasks 4 and 5 after the parent sent the subagent back.",
              filesTouched: [],
              commandsRun: ["printf 'tasks 4 and 5 complete\\n' >/tmp/openelinaro-subagent-phase-two.txt"],
              verificationCommands: [],
              blockers: [],
            },
            type: "tool_call",
          },
        ],
      });
    }
  }

  if (sessionId.includes(":timeout-test")) {
    if (latestHumanText.includes("You have reached the workflow timeout.")) {
      return new AIMessage(
        "Timeout reached. I inspected the workspace and confirmed the task target, but I stopped before any further tool use. Next step: relaunch the subagent with more time or continue from the current workspace state.",
      );
    }

    return new AIMessage("Worker should have been halted by the workflow timeout.");
  }

  if (sessionId.includes(":hard-timeout-test")) {
    if (latestHumanText.includes("Background subagent completion update.")) {
      return new AIMessage("Parent observed child hard-timeout completion.");
    }

    return new AIMessage("Hard-timeout worker should not have produced a normal response.");
  }

  if (sessionId.endsWith(":smoke-test") && parentResumeScenario) {
    if (!latestTool) {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "phase-one-command",
            name: "exec_command",
            args: {
              command: "printf 'tasks 1 2 and 3 complete\\n' >/tmp/openelinaro-subagent-phase-one.txt",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (latestTool.name === "exec_command") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "phase-one-submit",
            name: "complete_coding_task",
            args: {
              status: "completed",
              summary: "Completed tasks 1, 2, and 3. Tasks 4 and 5 remain for the same milestone.",
              filesTouched: [],
              commandsRun: ["printf 'tasks 1 2 and 3 complete\\n' >/tmp/openelinaro-subagent-phase-one.txt"],
              verificationCommands: [],
              blockers: [],
            },
            type: "tool_call",
          },
        ],
      });
    }
  }

  if (sessionId.endsWith(":smoke-test")) {
    if (!latestTool) {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "task-whoami",
            name: "exec_command",
            args: {
              command: "whoami",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (latestTool.name === "exec_command") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "task-submit",
            name: "complete_coding_task",
            args: {
              status: "completed",
              summary: "Ran whoami in the workspace and confirmed the restricted subagent completed the assigned task.",
              filesTouched: [],
              commandsRun: ["whoami"],
              verificationCommands: [],
              blockers: [],
            },
            type: "tool_call",
          },
        ],
      });
    }
  }

  if (latestHumanText.includes("Background subagent completion update.")) {
    if (latestHumanText.includes("Tasks 4 and 5 remain")) {
      const runId = latestHumanText.match(/Run id: (run-[a-z0-9-]+)/i)?.[1];
      if (!runId) {
        return new AIMessage("Parent could not parse the returned subagent run id.");
      }

      if (latestTool?.name === "resume_coding_agent") {
        return new AIMessage("Parent sent the subagent back to finish tasks 4 and 5.");
      }

      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "parent-resume-child",
            name: "resume_coding_agent",
            args: {
              runId,
              message: followUpInstruction,
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (latestHumanText.includes("Finished tasks 4 and 5")) {
      return new AIMessage("Parent confirmed the subagent finished tasks 4 and 5 after the follow-up.");
    }

    return new AIMessage(
      latestHumanText.includes("hard timeout")
        ? "Parent observed child hard-timeout completion."
        : latestHumanText.includes("Workflow reached timeout")
        ? "Parent observed child timeout completion."
        : "Parent observed child completion.",
    );
  }

  return new AIMessage(`Unhandled scripted connector request for ${sessionId}.`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

describe("OpenElinaro subagent e2e", () => {
  beforeAll(async () => {
    previousCwd = process.cwd();
    tempRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-subagent-e2e-")),
    );

    writeTestProfileRegistry();
    writeTestProjectRegistry();
    writeWorkspaceFixture();
    copyDirectory("system_prompt");

    process.chdir(tempRoot);
    updateTestRuntimeConfig((config) => {
      config.core.app.workflow.hardTimeoutGraceMs = 150;
    });

    activeConnectorModule = await importFresh("src/connectors/active-model-connector.ts");
    memoryServiceModule = await importFresh("src/services/memory-service.ts");
    modelServiceModule = await importFresh("src/services/model-service.ts");
    conversationStoreModule = await importFresh("src/services/conversation-store.ts");
    appRuntimeModule = await importFresh("src/app/runtime.ts");

    originalDoGenerate = activeConnectorModule.ActiveModelConnector.prototype.doGenerate;
    originalEnsureReady = memoryServiceModule.MemoryService.prototype.ensureReady;
    originalInspectContextWindowUsage = modelServiceModule.ModelService.prototype.inspectContextWindowUsage;

    memoryServiceModule.MemoryService.prototype.ensureReady = async function ensureReady() {
      return {} as Awaited<ReturnType<typeof originalEnsureReady>>;
    };
    modelServiceModule.ModelService.prototype.inspectContextWindowUsage = async function inspectContextWindowUsage(params) {
      return {
        conversationKey: params.conversationKey,
        providerId: "openai-codex",
        modelId: "gpt-5.4",
        method: "heuristic_estimate",
        usedTokens: 0,
        maxContextTokens: 200_000,
        remainingTokens: 200_000,
        maxOutputTokens: 8_192,
        remainingReplyBudgetTokens: 8_192,
        utilizationPercent: 0,
        breakdownMethod: "heuristic_estimate",
        breakdown: {
          systemPromptTokens: 0,
          userMessageTokens: 0,
          assistantReplyTokens: 0,
          toolCallInputTokens: 0,
          toolResponseTokens: 0,
          toolDefinitionTokens: 0,
          estimatedTotalTokens: 0,
        },
      };
    };
    activeConnectorModule.ActiveModelConnector.prototype.doGenerate = async function doGenerate(
      options: LanguageModelV3CallOptions,
    ): Promise<LanguageModelV3GenerateResult> {
      const request = buildScriptedConnectorRequest(options);
      scriptedRequests.push(request);
      const latestHumanText = extractLatestHumanText(request);
      if (
        request.sessionId?.endsWith(":timeout-test")
        && !latestHumanText.includes("You have reached the workflow timeout.")
      ) {
        await new Promise<never>((_, reject) => {
          if (options.abortSignal?.aborted) {
            reject(new Error("aborted"));
            return;
          }

          const handle = setTimeout(() => reject(new Error("worker did not time out")), 10_000);
          const onAbort = () => {
            clearTimeout(handle);
            reject(new Error("aborted"));
          };
          options.abortSignal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (request.sessionId?.endsWith(":hard-timeout-test")) {
        await new Promise<never>((_, reject) => {
          if (options.abortSignal?.aborted) {
            reject(new Error("aborted"));
            return;
          }

          const onAbort = () => reject(new Error("aborted"));
          options.abortSignal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (request.sessionId?.endsWith(":hard-timeout-test:timeout-summary")) {
        await new Promise<never>(() => {});
      }
      return toGenerateResultFromAIMessage(scriptedWorkflowResponse(request), "active-model-router", "scripted-model");
    };
  });

  afterAll(() => {
    activeConnectorModule.ActiveModelConnector.prototype.doGenerate = originalDoGenerate;
    memoryServiceModule.MemoryService.prototype.ensureReady = originalEnsureReady;
    modelServiceModule.ModelService.prototype.inspectContextWindowUsage = originalInspectContextWindowUsage;
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("launches a restricted subagent and injects its completion back into the parent thread", async () => {
    scriptedRequests.length = 0;
    const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });
    const backgroundResponses: Array<{ conversationKey: string; response: { message: string } }> = [];
    app.setBackgroundConversationNotifier(async (payload) => {
      backgroundResponses.push(payload);
    });

    const launchResponse = await app.invokeRoutineTool(
      "launch_coding_agent",
      {
        goal: "Perform a trivial startup test: inspect the current working directory and return a one- or two-sentence summary proving the restricted subagent can run.",
        profile: "restricted",
        timeoutMs: 30_000,
      },
      {
        conversationKey: "e2e:subagent:parent-thread",
      },
    );

    const runIdMatch = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i);
    expect(runIdMatch).not.toBeNull();
    const runId = runIdMatch?.[1];
    expect(runId).toBeTruthy();

    await waitFor(async () => {
      const run = app.getWorkflowRun(runId!);
      return run?.status === "completed" && backgroundResponses.length > 0;
    });

    const completedRun = app.getWorkflowRun(runId!);
    expect(completedRun?.profileId).toBe("restricted");
    expect(completedRun?.status).toBe("completed");
    expect(completedRun?.launchDepth).toBe(1);
    expect(completedRun?.resultSummary).toContain("restricted subagent");
    expect(completedRun?.executionLog.some((entry) => entry.includes("tool: `exec_command` command=\"whoami\""))).toBe(true);
    expect(completedRun?.taskReports?.[0]?.commandsRun).toContain("whoami");

    const plannerRequest = scriptedRequests.find((request) => request.sessionId?.endsWith(":plan"));
    const workerRequest = scriptedRequests.find((request) => /:smoke-test$/.test(request.sessionId ?? ""));
    expect(plannerRequest?.systemPrompt).toContain("You are OpenElinaro");
    expect(plannerRequest?.systemPrompt).toContain("You are a background coding planner.");
    expect(plannerRequest?.systemPrompt).toContain("Execution mode: background coding subagent.");
    expect(plannerRequest?.systemPrompt).toContain("System: OpenElinaro local-first agent runtime.");
    expect(plannerRequest?.systemPrompt).toContain("Profile: restricted");
    expect(plannerRequest?.systemPrompt).toContain("Project context: no projects are registered.");
    expect(plannerRequest?.systemPrompt).toContain("Workflow agent role: background coding planner.");
    expect(workerRequest?.systemPrompt).toContain("You are OpenElinaro");
    expect(workerRequest?.systemPrompt).toContain("You are a background coding worker.");
    expect(workerRequest?.systemPrompt).toContain("Tool scope: only the coding planner/worker tools for this run are available.");
    expect(workerRequest?.systemPrompt).toContain("Assigned task id: smoke-test");
    expect(workerRequest?.systemPrompt).toContain("Assigned task title: Verify workspace listing");

    expect(backgroundResponses).toHaveLength(1);
    expect(backgroundResponses[0]?.conversationKey).toBe("e2e:subagent:parent-thread");
    expect(backgroundResponses[0]?.response.message).toBe("Parent observed child completion.");

    const conversations = new conversationStoreModule.ConversationStore();
    const conversation = conversations.get("e2e:subagent:parent-thread");
    const humanMessages = conversation.messages.filter((message) => message instanceof HumanMessage);
    const aiMessages = conversation.messages.filter((message) => message instanceof AIMessage);

    expect(humanMessages.some((message) => {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return content.includes("Background subagent completion update.");
    })).toBe(true);
    expect(aiMessages.some((message) => {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return content.includes("Parent observed child completion.");
    })).toBe(true);
  });

  test("halts a timed out subagent, collects a timeout summary, and injects it back into the parent thread", async () => {
    const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });
    const backgroundResponses: Array<{ conversationKey: string; response: { message: string } }> = [];
    app.setBackgroundConversationNotifier(async (payload) => {
      backgroundResponses.push(payload);
    });

    const launchResponse = await app.invokeRoutineTool(
      "launch_coding_agent",
      {
        goal: "Trigger the timeout handoff by starting work that must stop at timeout and summarize what has been done.",
        profile: "restricted",
        timeoutMs: 4_000,
      },
      {
        conversationKey: "e2e:subagent:parent-thread-timeout",
      },
    );

    const runIdMatch = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i);
    expect(runIdMatch).not.toBeNull();
    const runId = runIdMatch?.[1];
    expect(runId).toBeTruthy();

    await waitFor(async () => {
      const run = app.getWorkflowRun(runId!);
      return run?.status === "failed" && backgroundResponses.length > 0;
    }, 15_000);

    const completedRun = app.getWorkflowRun(runId!);
    expect(completedRun?.profileId).toBe("restricted");
    expect(completedRun?.status).toBe("failed");
    expect(completedRun?.resultSummary).toContain("Workflow reached timeout");
    expect(completedRun?.resultSummary).toContain("I inspected the workspace");
    expect(completedRun?.completionMessage).toContain("Workflow reached timeout");
    expect(completedRun?.executionLog.some((entry) => entry.includes("Task timeout-test failed"))).toBe(true);

    expect(backgroundResponses).toHaveLength(1);
    expect(backgroundResponses[0]?.conversationKey).toBe("e2e:subagent:parent-thread-timeout");
    expect(backgroundResponses[0]?.response.message).toBe("Parent observed child timeout completion.");

    const conversations = new conversationStoreModule.ConversationStore();
    const conversation = conversations.get("e2e:subagent:parent-thread-timeout");
    const humanMessages = conversation.messages.filter((message) => message instanceof HumanMessage);
    const aiMessages = conversation.messages.filter((message) => message instanceof AIMessage);

    expect(humanMessages.some((message) => {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return content.includes("Background subagent completion update.")
        && content.includes("Workflow reached timeout")
        && content.includes("I inspected the workspace");
    })).toBe(true);
    expect(aiMessages.some((message) => {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return content.includes("Parent observed child timeout completion.");
    })).toBe(true);
  });

  test("hard-times out a subagent that is still hanging after the timeout handoff window", async () => {
    const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });
    const backgroundResponses: Array<{ conversationKey: string; response: { message: string } }> = [];
    app.setBackgroundConversationNotifier(async (payload) => {
      backgroundResponses.push(payload);
    });

    const launchResponse = await app.invokeRoutineTool(
      "launch_coding_agent",
      {
        goal: "Trigger the hard timeout handoff by hanging even during the timeout summary.",
        profile: "restricted",
        timeoutMs: 4_000,
      },
      {
        conversationKey: "e2e:subagent:parent-thread-hard-timeout",
      },
    );

    const runIdMatch = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i);
    expect(runIdMatch).not.toBeNull();
    const runId = runIdMatch?.[1];
    expect(runId).toBeTruthy();

    await waitFor(async () => {
      const run = app.getWorkflowRun(runId!);
      return run?.status === "failed" && backgroundResponses.length > 0;
    }, 15_000);

    const completedRun = app.getWorkflowRun(runId!);
    expect(completedRun?.profileId).toBe("restricted");
    expect(completedRun?.status).toBe("failed");
    expect(completedRun?.resultSummary).toContain("hard timeout");
    expect(completedRun?.resultSummary).toContain("terminated");
    expect(completedRun?.error).toContain("hard timeout");
    expect(completedRun?.completionMessage).toContain("hard timeout");

    expect(backgroundResponses).toHaveLength(1);
    expect(backgroundResponses[0]?.conversationKey).toBe("e2e:subagent:parent-thread-hard-timeout");
    expect(backgroundResponses[0]?.response.message).toBe("Parent observed child hard-timeout completion.");

    const conversations = new conversationStoreModule.ConversationStore();
    const conversation = conversations.get("e2e:subagent:parent-thread-hard-timeout");
    const humanMessages = conversation.messages.filter((message) => message instanceof HumanMessage);
    const aiMessages = conversation.messages.filter((message) => message instanceof AIMessage);

    expect(humanMessages.some((message) => {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return content.includes("Background subagent completion update.")
        && content.includes("hard timeout")
        && content.includes("terminated");
    })).toBe(true);
    expect(aiMessages.some((message) => {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return content.includes("Parent observed child hard-timeout completion.");
    })).toBe(true);
  });

});
