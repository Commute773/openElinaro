import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTaskPlan } from "../domain/task-plan";
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
let memoryServiceModule: typeof import("../services/memory-service");
let shellServiceModule: typeof import("../services/shell-service");

let originalDoGenerate: typeof activeConnectorModule.ActiveModelConnector.prototype.doGenerate;
let originalEnsureReady: typeof memoryServiceModule.MemoryService.prototype.ensureReady;
let originalShellExec: typeof shellServiceModule.ShellService.prototype.exec;
let originalShellExecVerification: typeof shellServiceModule.ShellService.prototype.execVerification;
const DEFAULT_MAX_CONSECUTIVE_TASK_ERRORS = 3;
const DEFAULT_RESUME_RETRY_DELAY_MS = 5_000;
const DEFAULT_STUCK_AFTER_MS = 15 * 60_000;
const DEFAULT_SERVICE_RESTART_CONTINUATION_MESSAGE =
  "System restarted. Continue what you were doing. This system restart may be unrelated to your actions.";

let scriptedHandler: ((request: ScriptedConnectorRequest) => AIMessage) | null = null;
let transientHarnessOfflineOnce = false;

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function copyDirectory(relativePath: string) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, relativePath), { recursive: true });
}

function writeTestProfileRegistry() {
  const shellUser = process.env.USER?.trim() || process.env.LOGNAME?.trim() || "codex";
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
          id: "swebench-smoke",
          name: "SWE-bench Smoke",
          roles: ["swebench-smoke"],
          memoryNamespace: "swebench-smoke",
          pathRoots: [tempRoot],
          shellUser,
          preferredProvider: "openai-codex",
          defaultModelId: "gpt-5.4",
          maxSubagentDepth: 0,
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
  fs.writeFileSync(path.join(tempRoot, "README.md"), "# runtime workflow fixture\n", "utf8");
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ name: "runtime-workflow-fixture", type: "module" }, null, 2),
    "utf8",
  );
}

function initGitRepo(repoRoot: string) {
  fs.mkdirSync(repoRoot, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "OpenElinaro Test"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: repoRoot, stdio: "ignore" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# linked worktree fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });
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

function latestTool(request: ScriptedConnectorRequest) {
  return [...request.messages]
    .reverse()
    .find((message): message is ToolMessage => message instanceof ToolMessage);
}

function latestHumanText(request: ScriptedConnectorRequest) {
  const message = [...request.messages]
    .reverse()
    .find((entry): entry is HumanMessage => entry instanceof HumanMessage);
  if (!message) {
    return "";
  }
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

function buildCodingAgentResponse(request: ScriptedConnectorRequest) {
  const sessionId = request.sessionId ?? "";
  const tool = latestTool(request);
  const humanText = latestHumanText(request);
  const followUpResumeScenario = humanText.includes("Return after phase one and wait for explicit resume instructions.");
  const followUpInstruction = "Go back and finish tasks 4 and 5. Only return when both are complete.";

  if (sessionId.endsWith(":plan")) {
    if (!tool) {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "plan-search",
            name: "tool_search",
            args: {
              query: "list files and inspect repository structure",
              scope: "coding-planner",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (tool.name === "tool_search") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "plan-list-dir",
            name: "list_dir",
            args: {
              path: tempRoot,
              limit: 50,
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (tool.name === "list_dir") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "plan-submit",
            name: "report_plan",
            args: {
              summary: followUpResumeScenario && humanText.includes(followUpInstruction)
                ? "Tasks 1, 2, and 3 are already done. Plan only the remaining tasks 4 and 5."
                : followUpResumeScenario
                  ? "Complete phase one, then return so the caller can decide whether to resume the same run."
                  : "Add a generated note and verify it contains the expected text.",
              tasks: [
                {
                  id: followUpResumeScenario && humanText.includes(followUpInstruction)
                    ? "phase-two"
                    : followUpResumeScenario
                      ? "phase-one"
                      : "write-generated-note",
                  title: followUpResumeScenario && humanText.includes(followUpInstruction)
                    ? "Finish tasks 4 and 5"
                    : followUpResumeScenario
                      ? "Complete phase one and stop"
                      : "Write the generated note",
                  executionMode: "serial",
                  dependsOn: [],
                  acceptanceCriteria: followUpResumeScenario && humanText.includes(followUpInstruction)
                    ? ["Finish the remaining tasks 4 and 5 before returning."]
                    : followUpResumeScenario
                      ? ["Complete phase one only, then wait for explicit resume instructions."]
                      : [
                          "Create GENERATED_NOTE.md with the expected content.",
                        ],
                  verificationCommands: followUpResumeScenario
                    ? []
                    : [
                        "grep -q \"generated by runtime workflow e2e\" GENERATED_NOTE.md",
                      ],
                },
              ],
            },
            type: "tool_call",
          },
        ],
      });
    }
  }

  if (sessionId.endsWith(":write-generated-note")) {
    if (!tool) {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "task-search",
            name: "tool_search",
            args: {
              query: "write and edit files in the workspace",
              scope: "coding-worker",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (tool.name === "tool_search") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "task-write-file",
            name: "write_file",
            args: {
              path: "GENERATED_NOTE.md",
              content: "# Generated Note\n\ngenerated by runtime workflow e2e\n",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (tool.name === "write_file") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "task-complete",
            name: "complete_coding_task",
            args: {
              status: "completed",
              summary: "Wrote GENERATED_NOTE.md and verified the expected content.",
              filesTouched: ["GENERATED_NOTE.md"],
              commandsRun: ["write_file GENERATED_NOTE.md"],
              verificationCommands: [],
              blockers: [],
            },
            type: "tool_call",
          },
        ],
      });
    }
  }

  if (sessionId.endsWith(":phase-one")) {
    if (!tool) {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "phase-one-write",
            name: "write_file",
            args: {
              path: "PHASE_ONE.md",
              content: "tasks 1, 2, and 3 complete\n",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (tool.name === "write_file") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "phase-one-complete",
            name: "complete_coding_task",
            args: {
              status: "completed",
              summary: "Completed tasks 1, 2, and 3. Tasks 4 and 5 remain for the same milestone.",
              filesTouched: ["PHASE_ONE.md"],
              commandsRun: [],
              verificationCommands: [],
              blockers: [],
            },
            type: "tool_call",
          },
        ],
      });
    }
  }

  if (sessionId.endsWith(":phase-two")) {
    if (!tool) {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "phase-two-write",
            name: "write_file",
            args: {
              path: "PHASE_TWO.md",
              content: "tasks 4 and 5 complete\n",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (tool.name === "write_file") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "phase-two-complete",
            name: "complete_coding_task",
            args: {
              status: "completed",
              summary: "Finished tasks 4 and 5 after the run was resumed.",
              filesTouched: ["PHASE_TWO.md"],
              commandsRun: [],
              verificationCommands: [],
              blockers: [],
            },
            type: "tool_call",
          },
        ],
      });
    }
  }

  return new AIMessage(`Unhandled scripted request for ${sessionId}.`);
}

function buildSoftFailureResponse(request: ScriptedConnectorRequest) {
  const sessionId = request.sessionId ?? "";

  if (sessionId.endsWith(":plan")) {
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "plan-submit-soft-failure",
          name: "report_plan",
          args: {
            summary: "Execute two independent tasks and tolerate one isolated task failure.",
            tasks: [
              {
                id: "fail-once",
                title: "Record a recoverable task failure",
                executionMode: "serial",
                dependsOn: [],
                acceptanceCriteria: ["Report a failed task without aborting the whole run."],
                verificationCommands: [],
              },
              {
                id: "recover-after-failure",
                title: "Complete a later independent task",
                executionMode: "serial",
                dependsOn: [],
                acceptanceCriteria: ["Finish successfully after the earlier task failure."],
                verificationCommands: [],
              },
            ],
          },
          type: "tool_call",
        },
      ],
    });
  }

  if (sessionId.endsWith(":fail-once")) {
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "task-submit-fail-once",
          name: "complete_coding_task",
          args: {
            status: "failed",
            summary: "Simulated recoverable task failure.",
            filesTouched: [],
            commandsRun: [],
            verificationCommands: [],
            blockers: [],
          },
          type: "tool_call",
        },
      ],
    });
  }

  if (sessionId.endsWith(":recover-after-failure")) {
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "task-submit-recover-after-failure",
          name: "complete_coding_task",
          args: {
            status: "completed",
            summary: "Completed the follow-up task after the earlier failure.",
            filesTouched: [],
            commandsRun: [],
            verificationCommands: [],
            blockers: [],
          },
          type: "tool_call",
        },
      ],
    });
  }

  return new AIMessage(`Unhandled scripted request for ${sessionId}.`);
}

function buildThresholdFailureResponse(request: ScriptedConnectorRequest) {
  const sessionId = request.sessionId ?? "";

  if (sessionId.endsWith(":plan")) {
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "plan-submit-threshold-failure",
          name: "report_plan",
          args: {
            summary: "Keep executing until the consecutive task error threshold is reached.",
            tasks: [
              {
                id: "fail-one",
                title: "First task failure",
                executionMode: "serial",
                dependsOn: [],
                acceptanceCriteria: ["Fail the first task."],
                verificationCommands: [],
              },
              {
                id: "fail-two",
                title: "Second consecutive task failure",
                executionMode: "serial",
                dependsOn: [],
                acceptanceCriteria: ["Fail the second task."],
                verificationCommands: [],
              },
              {
                id: "should-not-run",
                title: "Task after threshold exhaustion",
                executionMode: "serial",
                dependsOn: [],
                acceptanceCriteria: ["This task should never execute."],
                verificationCommands: [],
              },
            ],
          },
          type: "tool_call",
        },
      ],
    });
  }

  if (sessionId.endsWith(":fail-one") || sessionId.endsWith(":fail-two")) {
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          id: `task-submit-${sessionId.split(":").at(-1)}`,
          name: "complete_coding_task",
          args: {
            status: "failed",
            summary: `Simulated failure for ${sessionId.split(":").at(-1)}.`,
            filesTouched: [],
            commandsRun: [],
            verificationCommands: [],
            blockers: [],
          },
          type: "tool_call",
        },
      ],
    });
  }

  if (sessionId.endsWith(":should-not-run")) {
    throw new Error("The threshold-exhausted task should not have executed.");
  }

  return new AIMessage(`Unhandled scripted request for ${sessionId}.`);
}

function buildVerificationRetryResponse(request: ScriptedConnectorRequest) {
  const sessionId = request.sessionId ?? "";

  if (sessionId.endsWith(":plan")) {
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "plan-submit-verification-retry",
          name: "report_plan",
          args: {
            summary: "Run a cargo test verifier that needs a writable temp directory retry.",
            tasks: [
              {
                id: "verify-with-retry",
                title: "Run cargo test verification with tempdir retry",
                executionMode: "serial",
                dependsOn: [],
                acceptanceCriteria: ["Retry cargo test verification with a shared TMPDIR if rustdoc tempdir creation is denied."],
                verificationCommands: [
                  "cargo test -p telecorder-whiplash -- coord",
                ],
              },
            ],
          },
          type: "tool_call",
        },
      ],
    });
  }

  if (sessionId.endsWith(":verify-with-retry")) {
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "task-submit-verification-retry",
          name: "complete_coding_task",
          args: {
            status: "completed",
            summary: "Submitted the coordinate conversion task for verification.",
            filesTouched: ["crates/telecorder-whiplash/src/coord.rs"],
            commandsRun: [],
            verificationCommands: [],
            blockers: [],
          },
          type: "tool_call",
        },
      ],
    });
  }

  return new AIMessage(`Unhandled scripted request for ${sessionId}.`);
}

function buildSandboxedVerificationResponse(request: ScriptedConnectorRequest) {
  const sessionId = request.sessionId ?? "";
  const tool = latestTool(request);

  if (sessionId.endsWith(":plan")) {
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "plan-submit-sandboxed-verification",
          name: "report_plan",
          args: {
            summary: "Write a note inside the sandboxed workspace and verify it through the workflow harness.",
            tasks: [
              {
                id: "write-sandboxed-note",
                title: "Write the sandboxed note",
                executionMode: "serial",
                dependsOn: [],
                acceptanceCriteria: ["Create SANDBOXED_NOTE.md with the expected content."],
                verificationCommands: [
                  "grep -q \"sandboxed verification ok\" SANDBOXED_NOTE.md",
                ],
              },
            ],
          },
          type: "tool_call",
        },
      ],
    });
  }

  if (sessionId.endsWith(":write-sandboxed-note")) {
    if (!tool) {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "sandboxed-write-file",
            name: "write_file",
            args: {
              path: "SANDBOXED_NOTE.md",
              content: "# Sandboxed Note\n\nsandboxed verification ok\n",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (tool.name === "write_file") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "sandboxed-complete",
            name: "complete_coding_task",
            args: {
              status: "completed",
              summary: "Wrote the sandboxed note and handed it off for verification.",
              filesTouched: ["SANDBOXED_NOTE.md"],
              commandsRun: ["write_file SANDBOXED_NOTE.md"],
              verificationCommands: [],
              blockers: [],
            },
            type: "tool_call",
          },
        ],
      });
    }
  }

  return new AIMessage(`Unhandled scripted request for ${sessionId}.`);
}

function buildPersistedWorkerResumeResponse(request: ScriptedConnectorRequest) {
  const sessionId = request.sessionId ?? "";
  const tool = latestTool(request);

  if (sessionId.endsWith(":resume-task")) {
    if (!tool) {
      throw new Error("worker session restarted from scratch instead of resuming persisted state");
    }

    if (tool.name === "tool_search") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "resume-write-file",
            name: "write_file",
            args: {
              path: "RESUMED_NOTE.md",
              content: "# Resumed Note\n\ncontinued after harness restart\n",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (tool.name === "write_file") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "resume-complete",
            name: "complete_coding_task",
            args: {
              status: "completed",
              summary: "Resumed the persisted worker session and finished the note.",
              filesTouched: ["RESUMED_NOTE.md"],
              commandsRun: ["write_file RESUMED_NOTE.md"],
              verificationCommands: [],
              blockers: [],
            },
            type: "tool_call",
          },
        ],
      });
    }
  }

  return new AIMessage(`Unhandled scripted request for ${sessionId}.`);
}

function buildPersistedWorkerResumeWithRestartNoticeResponse(request: ScriptedConnectorRequest) {
  const sessionId = request.sessionId ?? "";
  const tool = latestTool(request);
  const latestHuman = latestHumanText(request);

  if (sessionId.endsWith(":resume-task")) {
    if (!tool) {
      throw new Error("worker session restarted from scratch instead of resuming persisted state");
    }
    if (!latestHuman.includes(DEFAULT_SERVICE_RESTART_CONTINUATION_MESSAGE)) {
      throw new Error("restart continuation note was not injected into the resumed worker session");
    }

    if (tool.name === "tool_search") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "resume-write-file-restart-note",
            name: "write_file",
            args: {
              path: "RESUMED_NOTE_AFTER_SERVICE_RESTART.md",
              content: "# Resumed Note\n\ncontinued after managed service restart\n",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (tool.name === "write_file") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "resume-complete-restart-note",
            name: "complete_coding_task",
            args: {
              status: "completed",
              summary: "Resumed the persisted worker session after a managed service restart.",
              filesTouched: ["RESUMED_NOTE_AFTER_SERVICE_RESTART.md"],
              commandsRun: ["write_file RESUMED_NOTE_AFTER_SERVICE_RESTART.md"],
              verificationCommands: [],
              blockers: [],
            },
            type: "tool_call",
          },
        ],
      });
    }
  }

  return new AIMessage(`Unhandled scripted request for ${sessionId}.`);
}

function buildTransientHarnessRecoveryResponse(request: ScriptedConnectorRequest) {
  const sessionId = request.sessionId ?? "";
  const tool = latestTool(request);

  if (sessionId.endsWith(":plan")) {
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "plan-submit-transient",
          name: "report_plan",
          args: {
            summary: "Finish the note even if the harness disconnects once.",
            tasks: [
              {
                id: "recover-after-offline",
                title: "Recover after transient harness loss",
                executionMode: "serial",
                dependsOn: [],
                acceptanceCriteria: ["Resume the worker session and finish the file write."],
                verificationCommands: [],
              },
            ],
          },
          type: "tool_call",
        },
      ],
    });
  }

  if (sessionId.endsWith(":recover-after-offline")) {
    if (!tool) {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "transient-search",
            name: "tool_search",
            args: {
              query: "write and edit files in the workspace",
              scope: "coding-worker",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (tool.name === "tool_search") {
      if (transientHarnessOfflineOnce) {
        transientHarnessOfflineOnce = false;
        throw new Error("Harness offline during workflow step.");
      }
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "transient-write-file",
            name: "write_file",
            args: {
              path: "TRANSIENT_NOTE.md",
              content: "# Transient Note\n\ncompleted after retry\n",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (tool.name === "write_file") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "transient-complete",
            name: "complete_coding_task",
            args: {
              status: "completed",
              summary: "Recovered after the harness came back and finished the task.",
              filesTouched: ["TRANSIENT_NOTE.md"],
              commandsRun: ["write_file TRANSIENT_NOTE.md"],
              verificationCommands: [],
              blockers: [],
            },
            type: "tool_call",
          },
        ],
      });
    }
  }

  return new AIMessage(`Unhandled scripted request for ${sessionId}.`);
}

let rateLimitOnce = false;

function buildRateLimitRecoveryResponse(request: ScriptedConnectorRequest) {
  const sessionId = request.sessionId ?? "";
  const tool = latestTool(request);

  if (sessionId.endsWith(":plan")) {
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "plan-submit-rate-limit",
          name: "report_plan",
          args: {
            summary: "Retry automatically after a transient rate limit.",
            tasks: [
              {
                id: "recover-after-rate-limit",
                title: "Recover after transient rate limit",
                executionMode: "serial",
                dependsOn: [],
                acceptanceCriteria: ["Write the file after the retry window passes."],
                verificationCommands: [],
              },
            ],
          },
          type: "tool_call",
        },
      ],
    });
  }

  if (sessionId.endsWith(":recover-after-rate-limit")) {
    if (!tool) {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "rate-limit-search",
            name: "tool_search",
            args: {
              query: "write and edit files in the workspace",
              scope: "coding-worker",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (tool.name === "tool_search") {
      if (rateLimitOnce) {
        rateLimitOnce = false;
        throw Object.assign(new Error("429 rate limit from provider"), {
          statusCode: 429,
          response: {
            headers: new Headers({
              "retry-after": "0.1",
            }),
          },
        });
      }
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "rate-limit-write-file",
            name: "write_file",
            args: {
              path: "RATE_LIMIT_NOTE.md",
              content: "# Rate Limit Note\n\ncompleted after retry\n",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (tool.name === "write_file") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "rate-limit-complete",
            name: "complete_coding_task",
            args: {
              status: "completed",
              summary: "Recovered after a transient rate limit and finished the task.",
              filesTouched: ["RATE_LIMIT_NOTE.md"],
              commandsRun: ["write_file RATE_LIMIT_NOTE.md"],
              verificationCommands: [],
              blockers: [],
            },
            type: "tool_call",
          },
        ],
      });
    }
  }

  return new AIMessage(`Unhandled scripted request for ${sessionId}.`);
}

describe("OpenElinaro runtime workflow e2e", () => {
  beforeAll(async () => {
    previousCwd = process.cwd();
    tempRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-runtime-workflow-e2e-")),
    );

    writeTestProfileRegistry();
    writeTestProjectRegistry();
    writeWorkspaceFixture();
    copyDirectory("system_prompt");

    process.chdir(tempRoot);

    activeConnectorModule = await importFresh("src/connectors/active-model-connector.ts");
    memoryServiceModule = await importFresh("src/services/memory-service.ts");
    shellServiceModule = await importFresh("src/services/shell-service.ts");
    appRuntimeModule = await importFresh("src/app/runtime.ts");

    originalDoGenerate = activeConnectorModule.ActiveModelConnector.prototype.doGenerate;
    originalEnsureReady = memoryServiceModule.MemoryService.prototype.ensureReady;
    originalShellExec = shellServiceModule.ShellService.prototype.exec;
    originalShellExecVerification = shellServiceModule.ShellService.prototype.execVerification;

    memoryServiceModule.MemoryService.prototype.ensureReady = async function ensureReady() {
      return {} as Awaited<ReturnType<typeof originalEnsureReady>>;
    };
    activeConnectorModule.ActiveModelConnector.prototype.doGenerate = async function doGenerate(
      options: LanguageModelV3CallOptions,
    ): Promise<LanguageModelV3GenerateResult> {
      if (!scriptedHandler) {
        throw new Error("No scripted handler was configured for ActiveModelConnector in this test.");
      }
      const request = buildScriptedConnectorRequest(options);
      return toGenerateResultFromAIMessage(scriptedHandler(request), "active-model-router", "scripted-model");
    };
  });

  afterAll(() => {
    activeConnectorModule.ActiveModelConnector.prototype.doGenerate = originalDoGenerate;
    memoryServiceModule.MemoryService.prototype.ensureReady = originalEnsureReady;
    shellServiceModule.ShellService.prototype.exec = originalShellExec;
    shellServiceModule.ShellService.prototype.execVerification = originalShellExecVerification;
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("handles workflow requests through the direct background lane without graph routing", async () => {
    scriptedHandler = () => new AIMessage("unused");
    const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });

    const response = await app.handleRequest({
      id: "workflow-request-e2e",
      kind: "workflow",
      text: "Run the prepared task plan",
      conversationKey: "e2e:workflow-thread",
      workflowPlan: createTaskPlan("Prepare status update", [
        {
          id: "collect",
          title: "Collect notes",
          status: "ready",
          executionMode: "serial",
          dependsOn: [],
        },
        {
          id: "summarize",
          title: "Summarize notes",
          status: "pending",
          executionMode: "serial",
          dependsOn: ["collect"],
        },
      ]),
    });

    expect(response.mode).toBe("accepted");
    expect(response.workflowRunId).toBeTruthy();

    await waitFor(() => {
      const run = app.getWorkflowRun(response.workflowRunId!);
      return run?.status === "completed";
    });

    const run = app.getWorkflowRun(response.workflowRunId!);
    expect(run?.kind).toBe("task-plan");
    expect(run?.status).toBe("completed");
    expect(run?.plan?.tasks.every((task) => task.status === "completed")).toBe(true);
    expect(run?.executionLog.some((entry) => entry.includes("Executed serial batch"))).toBe(true);
    expect(run?.resultSummary).toBe("Workflow finished successfully.");
  });

  test("launches git-backed coding agents in isolated linked worktrees", async () => {
    const gitRepoRoot = path.join(tempRoot, "git-linked-worktree");
    initGitRepo(gitRepoRoot);
    scriptedHandler = (request) => {
      const sessionId = request.sessionId ?? "";
      const tool = latestTool(request);

      if (sessionId.endsWith(":plan")) {
        return new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "plan-submit-linked",
              name: "report_plan",
              args: {
                summary: "Write a note in the isolated linked worktree.",
                tasks: [
                  {
                    id: "write-linked-note",
                    title: "Write the linked-worktree note",
                    executionMode: "serial",
                    dependsOn: [],
                    acceptanceCriteria: ["Create LINKED_WORKTREE_NOTE.md in the linked worktree."],
                    verificationCommands: [],
                  },
                ],
              },
              type: "tool_call",
            },
          ],
        });
      }

      if (sessionId.endsWith(":write-linked-note")) {
        if (!tool) {
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "write-linked-note",
                name: "write_file",
                args: {
                  path: "LINKED_WORKTREE_NOTE.md",
                  content: "linked worktree output\n",
                },
                type: "tool_call",
              },
            ],
          });
        }

        if (tool.name === "write_file") {
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "complete-linked-note",
                name: "complete_coding_task",
                args: {
                  status: "completed",
                  summary: "Wrote the note inside the linked worktree.",
                  filesTouched: ["LINKED_WORKTREE_NOTE.md"],
                  commandsRun: [],
                  verificationCommands: [],
                  blockers: [],
                },
                type: "tool_call",
              },
            ],
          });
        }
      }

      return new AIMessage("Unexpected request.");
    };

    const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });
    const launchResponse = await app.invokeRoutineTool("launch_coding_agent", {
      goal: "Write a note in the git-backed repo.",
      cwd: gitRepoRoot,
      timeoutMs: 30_000,
    });
    const runId = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i)?.[1];
    expect(runId).toBeTruthy();

    await waitFor(() => app.getWorkflowRun(runId!)?.status === "completed");

    const run = app.getWorkflowRun(runId!);
    expect(run?.workspaceCwd).toBeTruthy();
    expect(run?.workspaceCwd).not.toBe(gitRepoRoot);
    expect(run?.workspaceCwd).toContain(`${path.sep}.openelinaro-worktrees${path.sep}`);
    expect(run?.executionLog.some((entry) => entry.includes("Allocated linked worktree:"))).toBe(true);
    expect(fs.existsSync(path.join(gitRepoRoot, "LINKED_WORKTREE_NOTE.md"))).toBe(false);
    expect(fs.readFileSync(path.join(run!.workspaceCwd!, "LINKED_WORKTREE_NOTE.md"), "utf8")).toContain(
      "linked worktree output",
    );
  });

  test("runs the imperative coding-agent planner and worker loop end to end", async () => {
    scriptedHandler = buildCodingAgentResponse;
    const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });

    const launchResponse = await app.invokeRoutineTool("launch_coding_agent", {
      goal: "Create a generated note in the current workspace and verify it.",
      timeoutMs: 30_000,
    });
    const runIdMatch = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i);
    expect(runIdMatch).not.toBeNull();
    const runId = runIdMatch?.[1];
    expect(runId).toBeTruthy();

    await waitFor(() => {
      const run = app.getWorkflowRun(runId!);
      return run?.status === "completed";
    });

    const run = app.getWorkflowRun(runId!);
    expect(run?.kind).toBe("coding-agent");
    expect(run?.status).toBe("completed");
    expect(run?.resultSummary).toBe("Add a generated note and verify it contains the expected text.");
    expect(run?.taskReports?.[0]?.filesTouched).toEqual(["GENERATED_NOTE.md"]);
    expect(run?.taskReports?.[0]?.verification[0]?.exitCode).toBe(0);
    expect(run?.completionMessage).toContain("Files touched: GENERATED_NOTE.md");
    expect(run?.executionLog.some((entry) => entry.includes("tool: `tool_search`"))).toBe(true);
    expect(run?.executionLog.some((entry) => entry.includes("tool: `write_file`"))).toBe(true);

    const generatedFile = path.join(tempRoot, "GENERATED_NOTE.md");
    expect(fs.existsSync(generatedFile)).toBe(true);
    expect(fs.readFileSync(generatedFile, "utf8")).toContain("generated by runtime workflow e2e");
  });

  test("resumes an existing coding-agent run with follow-up instructions on the same run id", async () => {
    scriptedHandler = buildCodingAgentResponse;
    const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });
    const followUpInstruction = "Go back and finish tasks 4 and 5. Only return when both are complete.";

    const launchResponse = await app.invokeRoutineTool("launch_coding_agent", {
      goal: "Return after phase one and wait for explicit resume instructions.",
      timeoutMs: 30_000,
    });
    const runId = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i)?.[1];
    expect(runId).toBeTruthy();

    await waitFor(() => app.getWorkflowRun(runId!)?.status === "completed");

    const initialRun = app.getWorkflowRun(runId!);
    expect(initialRun?.completionMessage).toContain("Tasks 4 and 5 remain");

    const resumeResponse = await app.invokeRoutineTool("resume_coding_agent", {
      runId,
      message: followUpInstruction,
    });
    expect(resumeResponse).toContain("Background coding agent resumed.");
    expect(resumeResponse).toContain(`Run id: ${runId}`);

    await waitFor(() => {
      const run = app.getWorkflowRun(runId!);
      return run?.status === "completed"
        && Boolean(run.executionLog.some((entry) => entry.includes("Main agent resumed the coding run.")))
        && Boolean(run.taskReports?.some((report) => report.taskId === "phase-two"));
    });

    const resumedRun = app.getWorkflowRun(runId!);
    expect(resumedRun?.executionLog.some((entry) => entry.includes(`Parent instruction: ${followUpInstruction}`))).toBe(true);
    expect(resumedRun?.taskReports?.some((report) => report.taskId === "phase-one")).toBe(true);
    expect(resumedRun?.taskReports?.some((report) => report.taskId === "phase-two")).toBe(true);
    expect(resumedRun?.taskReports?.find((report) => report.taskId === "phase-two")?.summary).toContain(
      "Finished tasks 4 and 5",
    );
    expect(fs.readFileSync(path.join(tempRoot, "PHASE_TWO.md"), "utf8")).toContain("tasks 4 and 5 complete");
  }, 15_000);

  test("defaults coding-agent launch and resume timeouts to one hour when omitted", async () => {
    scriptedHandler = buildCodingAgentResponse;
    const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });

    const launchResponse = await app.invokeRoutineTool("launch_coding_agent", {
      goal: "Inspect the current workspace and wait for resume defaults coverage.",
    });
    const runId = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i)?.[1];
    expect(runId).toBeTruthy();

    const launchedRun = app.getWorkflowRun(runId!);
    expect(launchedRun?.timeoutMs).toBe(3_600_000);
    expect(launchResponse).toContain("Timeout: 3600000ms");

    await waitFor(() => {
      const run = app.getWorkflowRun(runId!);
      return run?.status === "completed";
    });

    const resumedResponse = await app.invokeRoutineTool("resume_coding_agent", {
      runId,
    });
    const resumedRun = app.getWorkflowRun(runId!);
    expect(resumedRun?.timeoutMs).toBe(3_600_000);
    expect(resumedResponse).toContain("Timeout: 3600000ms");
  });

  test("keeps a coding-agent run alive after an isolated task failure", async () => {
    scriptedHandler = buildSoftFailureResponse;
    const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });

    const launchResponse = await app.invokeRoutineTool("launch_coding_agent", {
      goal: "Keep going after one task fails.",
      timeoutMs: 30_000,
    });
    const runId = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i)?.[1];
    expect(runId).toBeTruthy();

    await waitFor(() => {
      const run = app.getWorkflowRun(runId!);
      return run?.status === "failed";
    });

    const run = app.getWorkflowRun(runId!);
    expect(run?.status).toBe("failed");
    expect(run?.taskIssueCount).toBe(1);
    expect(run?.taskErrorCount).toBe(1);
    expect(run?.consecutiveTaskErrorCount).toBe(0);
    expect(run?.resultSummary).toContain("finished with task issues");
    expect(run?.completionMessage).toContain("Task issues: 1");
    expect(run?.plan?.tasks.map((task) => task.status)).toEqual(["failed", "completed"]);
  });

  test("verifies sandboxed worker output through the harness verifier without exposing exec_command", async () => {
    scriptedHandler = buildSandboxedVerificationResponse;
    const observedVerificationCommands: string[] = [];
    const observedSystemPrompts: string[] = [];

    shellServiceModule.ShellService.prototype.execVerification = async function execVerification(params) {
      observedVerificationCommands.push(params.command);
      if (params.command === "grep -q \"sandboxed verification ok\" SANDBOXED_NOTE.md") {
        return {
          command: params.command,
          cwd: path.resolve(tempRoot),
          timeoutMs: params.timeoutMs ?? 180_000,
          sudo: false,
          effectiveUser: "sandbox-verifier",
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      }
      return originalShellExecVerification.call(this, params);
    };

    scriptedHandler = (request) => {
      observedSystemPrompts.push(request.systemPrompt);
      return buildSandboxedVerificationResponse(request);
    };

    try {
      const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });
      const launchResponse = await app.invokeRoutineTool("launch_coding_agent", {
        goal: "Verify a sandboxed worker task through the workflow harness.",
        profile: "swebench-smoke",
        cwd: tempRoot,
        timeoutMs: 30_000,
      });
      const runId = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i)?.[1];
      expect(runId).toBeTruthy();

      await waitFor(() => app.getWorkflowRun(runId!)?.status === "completed", 10_000);

      const run = app.getWorkflowRun(runId!);
      expect(run?.status).toBe("completed");
      expect(run?.profileId).toBe("swebench-smoke");
      expect(run?.taskReports?.[0]?.verification[0]?.exitCode).toBe(0);
      expect(observedVerificationCommands.length).toBeGreaterThanOrEqual(1);
      expect(
        observedVerificationCommands.every((command) =>
          command === "grep -q \"sandboxed verification ok\" SANDBOXED_NOTE.md",
        ),
      ).toBe(true);
      expect(fs.readFileSync(path.join(tempRoot, "SANDBOXED_NOTE.md"), "utf8")).toContain(
        "sandboxed verification ok",
      );
      expect(
        observedSystemPrompts.some((prompt) => prompt.includes("todo_write and todo_read")),
      ).toBe(false);
      expect(
        observedSystemPrompts.some((prompt) => prompt.includes("keep your internal task list current")),
      ).toBe(false);
    } finally {
      shellServiceModule.ShellService.prototype.execVerification = originalShellExecVerification;
    }
  });

  test("fails a coding-agent run only after the consecutive task error threshold is reached", async () => {
    scriptedHandler = buildThresholdFailureResponse;
    updateWorkflowConfig({ maxConsecutiveTaskErrors: 2 });
    const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });

    try {
      const launchResponse = await app.invokeRoutineTool("launch_coding_agent", {
        goal: "Stop only after two consecutive task failures.",
        timeoutMs: 30_000,
      });
      const runId = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i)?.[1];
      expect(runId).toBeTruthy();

      await waitFor(() => {
        const run = app.getWorkflowRun(runId!);
        return run?.status === "failed";
      });

      const run = app.getWorkflowRun(runId!);
      expect(run?.status).toBe("failed");
      expect(run?.taskIssueCount).toBe(2);
      expect(run?.taskErrorCount).toBe(2);
      expect(run?.consecutiveTaskErrorCount).toBe(2);
      expect(run?.resultSummary).toContain("consecutive task errors");
      expect(run?.plan?.tasks.find((task) => task.id === "should-not-run")?.status).toBe("ready");
    } finally {
      updateWorkflowConfig({ maxConsecutiveTaskErrors: DEFAULT_MAX_CONSECUTIVE_TASK_ERRORS });
    }
  });

  test("resumes a persisted in-flight worker session after app restart", async () => {
    scriptedHandler = buildPersistedWorkerResumeResponse;
    const workflowSessionStoreModule = await importFresh<typeof import("../services/workflow-session-store")>("src/services/workflow-session-store.ts");

    const runId = "run-resume-e2e";
    const taskId = "resume-task";
    const userPrompt = [
      "Overall goal: Resume an interrupted worker session after restart.",
      `Workspace cwd: ${tempRoot}`,
      `Assigned task id: ${taskId}`,
      "Assigned task title: Resume after restart",
      "Acceptance criteria:\n- Finish the note from the persisted worker session.",
      "Suggested verification commands: determine and run the smallest relevant checks yourself.",
      "Inspect, implement, verify, then submit the structured result.",
    ].join("\n\n");

    fs.writeFileSync(
      path.join(tempRoot, ".openelinarotest", "workflows.json"),
      `${JSON.stringify({
        runs: [
          {
            id: runId,
            kind: "coding-agent",
            goal: "Resume an interrupted worker session after restart.",
            profileId: "root",
            status: "running",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            executionStartedAt: new Date(Date.now() - 2_000).toISOString(),
            currentSessionId: `${runId}:${taskId}`,
            currentTaskId: taskId,
            workspaceCwd: tempRoot,
            timeoutMs: 30_000,
            executionLog: ["Worker session interrupted before harness restart."],
            plan: createTaskPlan("Resume an interrupted worker session after restart.", [
              {
                id: taskId,
                title: "Resume after restart",
                status: "ready",
                executionMode: "serial",
                dependsOn: [],
                acceptanceCriteria: ["Finish the note from the persisted worker session."],
                verificationCommands: [],
              },
            ]),
            taskReports: [],
          },
        ],
      }, null, 2)}\n`,
    );

    const workflowSessions = new workflowSessionStoreModule.WorkflowSessionStore();
    workflowSessions.save({
      key: `${runId}:${taskId}`,
      runId,
      scope: "worker",
      taskId,
      messages: [
        new HumanMessage(userPrompt),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "resume-search",
              name: "tool_search",
              args: { query: "write and edit files in the workspace", scope: "coding-worker" },
              type: "tool_call",
            },
          ],
        }),
        new ToolMessage({
          content: "Newly activated: write_file\nVisible tool count after search: 2",
          tool_call_id: "resume-search",
          name: "tool_search",
          status: "success",
        }),
      ],
      activeToolNames: ["tool_search", "write_file"],
      progressLog: ["[resume-task] tool: `tool_search`"],
      turns: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });

    await waitFor(() => app.getWorkflowRun(runId)?.status === "completed", 10_000);

    const run = app.getWorkflowRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.taskReports?.[0]?.summary).toContain("persisted worker session");
    expect(run?.executionLog.some((entry) => entry.includes("Persisted workflow state will resume automatically"))).toBe(true);
    expect(fs.readFileSync(path.join(tempRoot, "RESUMED_NOTE.md"), "utf8")).toContain(
      "continued after harness restart",
    );
    expect(workflowSessions.get(`${runId}:${taskId}`)).toBeUndefined();
  });

  test("resumes interrupted coding agents after a managed-service restart with a continuation note", async () => {
    scriptedHandler = buildPersistedWorkerResumeWithRestartNoticeResponse;
    const workflowSessionStoreModule = await importFresh<typeof import("../services/workflow-session-store")>("src/services/workflow-session-store.ts");
    const serviceRestartNoticeModule = await importFresh<typeof import("../services/service-restart-notice-service")>("src/services/service-restart-notice-service.ts");

    const runId = "run-resume-after-service-restart-e2e";
    const taskId = "resume-task";
    const userPrompt = [
      "Overall goal: Resume an interrupted worker session after managed-service restart.",
      `Workspace cwd: ${tempRoot}`,
      `Assigned task id: ${taskId}`,
      "Assigned task title: Resume after managed-service restart",
      "Acceptance criteria:\n- Finish the note from the persisted worker session after restart.",
      "Suggested verification commands: determine and run the smallest relevant checks yourself.",
      "Inspect, implement, verify, then submit the structured result.",
    ].join("\n\n");

    fs.writeFileSync(
      path.join(tempRoot, ".openelinarotest", "workflows.json"),
      `${JSON.stringify({
        runs: [
          {
            id: runId,
            kind: "coding-agent",
            goal: "Resume an interrupted worker session after managed-service restart.",
            profileId: "root",
            status: "running",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            executionStartedAt: new Date(Date.now() - 2_000).toISOString(),
            currentSessionId: `${runId}:${taskId}`,
            currentTaskId: taskId,
            workspaceCwd: tempRoot,
            timeoutMs: 30_000,
            executionLog: ["Worker session interrupted before managed-service restart."],
            plan: createTaskPlan("Resume an interrupted worker session after managed-service restart.", [
              {
                id: taskId,
                title: "Resume after managed-service restart",
                status: "ready",
                executionMode: "serial",
                dependsOn: [],
                acceptanceCriteria: ["Finish the note from the persisted worker session after restart."],
                verificationCommands: [],
              },
            ]),
            taskReports: [],
          },
        ],
      }, null, 2)}\n`,
    );

    const workflowSessions = new workflowSessionStoreModule.WorkflowSessionStore();
    workflowSessions.save({
      key: `${runId}:${taskId}`,
      runId,
      scope: "worker",
      taskId,
      messages: [
        new HumanMessage(userPrompt),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "resume-search-restart-note",
              name: "tool_search",
              args: { query: "write and edit files in the workspace", scope: "coding-worker" },
              type: "tool_call",
            },
          ],
        }),
        new ToolMessage({
          content: "Newly activated: write_file\nVisible tool count after search: 2",
          tool_call_id: "resume-search-restart-note",
          name: "tool_search",
          status: "success",
        }),
      ],
      activeToolNames: ["tool_search", "write_file"],
      progressLog: ["[resume-task] tool: `tool_search`"],
      turns: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    new serviceRestartNoticeModule.ServiceRestartNoticeService().recordPendingNotice({ source: "feature_manage" });

    const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });

    await waitFor(() => app.getWorkflowRun(runId)?.status === "completed", 10_000);

    const run = app.getWorkflowRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.taskReports?.[0]?.summary).toContain("managed service restart");
    expect(run?.executionLog.some((entry) => entry.includes("Managed service restart detected."))).toBe(true);
    expect(fs.readFileSync(path.join(tempRoot, "RESUMED_NOTE_AFTER_SERVICE_RESTART.md"), "utf8")).toContain(
      "continued after managed service restart",
    );
    expect(workflowSessions.get(`${runId}:${taskId}`)).toBeUndefined();
    expect(fs.existsSync(path.join(tempRoot, ".openelinarotest", "service-restart-notice.json"))).toBe(false);
  });

  test("requeues and retries a coding-agent run after a transient harness outage", async () => {
    transientHarnessOfflineOnce = true;
    scriptedHandler = buildTransientHarnessRecoveryResponse;
    updateWorkflowConfig({ resumeRetryDelayMs: 50 });

    try {
      const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });

      const launchResponse = await app.invokeRoutineTool("launch_coding_agent", {
        goal: "Recover after a transient harness outage.",
        timeoutMs: 30_000,
      });
      const runId = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i)?.[1];
      expect(runId).toBeTruthy();

      await waitFor(() => {
        const run = app.getWorkflowRun(runId!);
        return run?.status === "running" && run.runningState === "backoff" && Boolean(run.nextAttemptAt);
      }, 5_000);

      const pausedRun = app.getWorkflowRun(runId!);
      expect(pausedRun?.resultSummary).toContain("transient harness interruption");
      expect(pausedRun?.retryCount).toBe(1);

      await waitFor(() => app.getWorkflowRun(runId!)?.status === "completed", 5_000);

      const run = app.getWorkflowRun(runId!);
      expect(run?.status).toBe("completed");
      expect(run?.executionLog.some((entry) => entry.includes("Harness offline during workflow step"))).toBe(true);
      expect(fs.readFileSync(path.join(tempRoot, "TRANSIENT_NOTE.md"), "utf8")).toContain(
        "completed after retry",
      );
    } finally {
      updateWorkflowConfig({ resumeRetryDelayMs: DEFAULT_RESUME_RETRY_DELAY_MS });
    }
  });

  test("retries a coding-agent run after a transient 429 rate limit", async () => {
    rateLimitOnce = true;
    scriptedHandler = buildRateLimitRecoveryResponse;
    updateWorkflowConfig({ resumeRetryDelayMs: 25 });

    try {
      const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });

      const launchResponse = await app.invokeRoutineTool("launch_coding_agent", {
        goal: "Recover after a transient provider rate limit.",
        timeoutMs: 30_000,
      });
      const runId = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i)?.[1];
      expect(runId).toBeTruthy();

      await waitFor(() => {
        const run = app.getWorkflowRun(runId!);
        return run?.status === "running" && run.runningState === "backoff" && Boolean(run.nextAttemptAt);
      }, 5_000);

      const pausedRun = app.getWorkflowRun(runId!);
      expect(pausedRun?.resultSummary).toContain("rate limit");
      expect(pausedRun?.retryCount).toBe(1);

      await waitFor(() => app.getWorkflowRun(runId!)?.status === "completed", 5_000);

      const run = app.getWorkflowRun(runId!);
      expect(run?.status).toBe("completed");
      expect(run?.executionLog.some((entry) => entry.includes("rate-limited"))).toBe(true);
      expect(fs.readFileSync(path.join(tempRoot, "RATE_LIMIT_NOTE.md"), "utf8")).toContain(
        "completed after retry",
      );
    } finally {
      updateWorkflowConfig({ resumeRetryDelayMs: DEFAULT_RESUME_RETRY_DELAY_MS });
    }
  });

  test("surfaces stuck coding-agent runs through workflow status while they are still running", async () => {
    updateWorkflowConfig({ stuckAfterMs: 50 });

    try {
      const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });
      const runId = "run-stuck-status-e2e";
      const staleProgressAt = new Date(Date.now() - 1_000).toISOString();

      (app as any).registry.save({
        id: runId,
        kind: "coding-agent",
        goal: "Show the stuck workflow status surface.",
        profileId: "root",
        status: "running",
        runningState: "active",
        createdAt: staleProgressAt,
        updatedAt: staleProgressAt,
        executionStartedAt: staleProgressAt,
        lastProgressAt: staleProgressAt,
        executionLog: ["Planner started but stopped making progress."],
        taskReports: [],
        timeoutMs: 30_000,
      });

      const status = JSON.parse(await app.invokeRoutineTool("workflow_status", {
        runId,
        format: "json",
      })) as {
        runs: Array<{
          id: string;
          status: string;
          runningState?: string;
          stuckSinceAt?: string;
          stuckReason?: string;
        }>;
      };

      expect(status.runs).toHaveLength(1);
      expect(status.runs[0]?.id).toBe(runId);
      expect(status.runs[0]?.status).toBe("running");
      expect(status.runs[0]?.runningState).toBe("stuck");
      expect(status.runs[0]?.stuckSinceAt).toBeTruthy();
      expect(status.runs[0]?.stuckReason).toContain("No recorded tool calls or task completions");
    } finally {
      updateWorkflowConfig({ stuckAfterMs: DEFAULT_STUCK_AFTER_MS });
    }
  });

  test("retries cargo test verification with a shared TMPDIR after rustdoc tempdir permission errors", async () => {
    scriptedHandler = buildVerificationRetryResponse;
    const observedCommands: string[] = [];

    shellServiceModule.ShellService.prototype.execVerification = async function execVerification(params) {
      observedCommands.push(params.command);
      if (params.command === "cargo test -p telecorder-whiplash -- coord") {
        return {
          command: params.command,
          cwd: path.resolve(tempRoot),
          timeoutMs: params.timeoutMs ?? 180_000,
          sudo: false,
          effectiveUser: "root",
          exitCode: 1,
          stdout: "running 13 tests\n\ntest result: ok. 13 passed; 0 failed;\n",
          stderr: [
            "Doc-tests telecorder_whiplash",
            "error: failed to create temporary directory: Permission denied",
            "rustdoctest temporary directory creation failed",
          ].join("\n"),
        };
      }

      if (params.command.startsWith("TMPDIR=/tmp/openelinaro-workflow-verification/root ")) {
        return {
          command: params.command,
          cwd: path.resolve(tempRoot),
          timeoutMs: params.timeoutMs ?? 180_000,
          sudo: false,
          effectiveUser: "root",
          exitCode: 0,
          stdout: "running 13 tests\n\ntest result: ok. 13 passed; 0 failed;\n",
          stderr: "",
        };
      }

      return originalShellExecVerification.call(this, params);
    };

    try {
      const app = new appRuntimeModule.OpenElinaroApp({ profileId: "root" });
      const launchResponse = await app.invokeRoutineTool("launch_coding_agent", {
        goal: "Retry cargo test verification with a shared TMPDIR when rustdoc tempdir creation fails.",
        timeoutMs: 30_000,
      });
      const runId = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i)?.[1];
      expect(runId).toBeTruthy();

      await waitFor(() => {
        const run = app.getWorkflowRun(runId!);
        return run?.status === "completed";
      });

      const run = app.getWorkflowRun(runId!);
      expect(run?.status).toBe("completed");
      expect(run?.taskReports?.[0]?.verification[0]?.exitCode).toBe(0);
      expect(run?.taskReports?.[0]?.verification[0]?.stderr).toContain(
        "Retried with shared TMPDIR",
      );
      expect(observedCommands).toContain("cargo test -p telecorder-whiplash -- coord");
      expect(
        observedCommands.some((command) =>
          command.startsWith("TMPDIR=/tmp/openelinaro-workflow-verification/root "),
        ),
      ).toBe(true);
    } finally {
      shellServiceModule.ShellService.prototype.execVerification = originalShellExecVerification;
    }
  });
});
function updateWorkflowConfig(values: Partial<{
  maxConsecutiveTaskErrors: number;
  resumeRetryDelayMs: number;
  stuckAfterMs: number;
}>) {
  updateTestRuntimeConfig((config) => {
    Object.assign(config.core.app.workflow, values);
  });
}
