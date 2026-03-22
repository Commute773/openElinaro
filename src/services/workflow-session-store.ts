import fs from "node:fs";
import path from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
  type StoredMessage,
} from "@langchain/core/messages";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";
import { telemetry as rootTelemetry, type TelemetryService } from "./telemetry";
import { timestamp } from "../utils/timestamp";

export type WorkflowSessionScope = "planner" | "worker";

export interface WorkflowSessionTurnRecord {
  index: number;
  startedAt: string;
  completedAt: string;
  modelId?: string;
  provider?: string;
  finishReason: string;
  rawFinishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  responseToolNames: string[];
  activeToolNames: string[];
  visibleToolNames?: string[];
}

export interface WorkflowSessionState {
  key: string;
  runId: string;
  scope: WorkflowSessionScope;
  taskId?: string;
  messages: BaseMessage[];
  activeToolNames: string[];
  progressLog: string[];
  turns: WorkflowSessionTurnRecord[];
  createdAt: string;
  updatedAt: string;
}

type StoredWorkflowSessionState = Omit<WorkflowSessionState, "messages"> & {
  messages: StoredMessage[];
};

type WorkflowSessionStoreShape = {
  version: 1;
  sessions: Record<string, StoredWorkflowSessionState>;
};

type WorkflowSessionArchiveEntry = {
  runId: string;
  archivedAt: string;
  sessions: StoredWorkflowSessionState[];
};

type WorkflowSessionArchiveStoreShape = {
  version: 1;
  entries: WorkflowSessionArchiveEntry[];
};

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

export class WorkflowSessionStore {
  constructor(
    private readonly storePath = resolveRuntimePath("workflow-sessions.json"),
    private readonly archivePath = resolveRuntimePath("workflow-session-history.json"),
    private readonly telemetry: TelemetryService = rootTelemetry.child({ component: "workflow_session_store" }),
  ) {}

  get(key: string): WorkflowSessionState | undefined {
    const store = this.readStore();
    const session = store.sessions[key];
    if (!session) {
      return undefined;
    }
    return {
      ...session,
      messages: mapStoredMessagesToChatMessages(session.messages),
      activeToolNames: uniqueStrings(session.activeToolNames),
      progressLog: [...session.progressLog],
      turns: Array.isArray(session.turns)
        ? session.turns.map((turn) => ({
            ...turn,
            visibleToolNames: uniqueStrings(turn.visibleToolNames ?? []),
          }))
        : [],
    };
  }

  ensure(params: {
    key: string;
    runId: string;
    scope: WorkflowSessionScope;
    taskId?: string;
    messages: BaseMessage[];
  }) {
    return this.get(params.key) ?? this.save({
      key: params.key,
      runId: params.runId,
      scope: params.scope,
      taskId: params.taskId,
      messages: params.messages,
      activeToolNames: [],
      progressLog: [],
      turns: [],
      createdAt: timestamp(),
      updatedAt: timestamp(),
    });
  }

  save(state: WorkflowSessionState): WorkflowSessionState {
    const store = this.readStore();
    const existing = store.sessions[state.key];
    const nextState: StoredWorkflowSessionState = {
      key: state.key,
      runId: state.runId,
      scope: state.scope,
      taskId: state.taskId,
      messages: mapChatMessagesToStoredMessages(state.messages),
      activeToolNames: uniqueStrings(state.activeToolNames),
      progressLog: state.progressLog.map((entry) => entry.trim()).filter(Boolean),
      turns: Array.isArray(state.turns)
        ? state.turns.map((turn) => ({
            ...turn,
            visibleToolNames: uniqueStrings(turn.visibleToolNames ?? []),
          }))
        : [],
      createdAt: existing?.createdAt ?? state.createdAt ?? timestamp(),
      updatedAt: timestamp(),
    };
    store.sessions[state.key] = nextState;
    this.writeStore(store);
    this.telemetry.event("workflow_session_store.saved", {
      workflowRunId: state.runId,
      taskId: state.taskId,
      entityType: "workflow_session",
      entityId: state.key,
      scope: state.scope,
      messageCount: state.messages.length,
      turnCount: nextState.turns.length,
    });
    return {
      ...nextState,
      messages: state.messages,
    };
  }

  addActiveTools(key: string, toolNames: string[]) {
    const existing = this.get(key);
    if (!existing) {
      return undefined;
    }
    return this.save({
      ...existing,
      activeToolNames: uniqueStrings(existing.activeToolNames.concat(toolNames)),
    });
  }

  appendProgress(key: string, message: string) {
    const existing = this.get(key);
    if (!existing) {
      return undefined;
    }
    return this.save({
      ...existing,
      progressLog: existing.progressLog.concat(message.trim()).filter(Boolean),
    });
  }

  appendTurn(key: string, turn: WorkflowSessionTurnRecord) {
    const existing = this.get(key);
    if (!existing) {
      return undefined;
    }
    return this.save({
      ...existing,
      turns: existing.turns.concat({
        ...turn,
        responseToolNames: uniqueStrings(turn.responseToolNames),
        activeToolNames: uniqueStrings(turn.activeToolNames),
        visibleToolNames: uniqueStrings(turn.visibleToolNames ?? []),
      }),
    });
  }

  appendHumanMessage(key: string, message: string) {
    const existing = this.get(key);
    if (!existing) {
      return undefined;
    }
    return this.save({
      ...existing,
      messages: existing.messages.concat(new HumanMessage(message)),
    });
  }

  clearRun(runId: string) {
    const store = this.readStore();
    const archivedSessions: StoredWorkflowSessionState[] = [];
    let changed = false;
    for (const [key, session] of Object.entries(store.sessions)) {
      if (session.runId !== runId) {
        continue;
      }
      archivedSessions.push(session);
      delete store.sessions[key];
      changed = true;
    }
    if (changed) {
      this.appendArchiveEntry({
        runId,
        archivedAt: timestamp(),
        sessions: archivedSessions,
      });
      this.writeStore(store);
      this.telemetry.event("workflow_session_store.cleared_run", {
        workflowRunId: runId,
        entityType: "workflow_run",
        entityId: runId,
        archivedSessionCount: archivedSessions.length,
      });
    }
  }

  private ensureStoreDir() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
  }

  private readStore(): WorkflowSessionStoreShape {
    this.ensureStoreDir();
    if (!fs.existsSync(this.storePath)) {
      return {
        version: 1,
        sessions: {},
      };
    }

    const parsed = JSON.parse(fs.readFileSync(this.storePath, "utf8")) as Partial<WorkflowSessionStoreShape>;
    return {
      version: 1,
      sessions: Object.fromEntries(
        Object.entries(parsed.sessions ?? {}).map(([key, session]) => [
          key,
          {
            key,
            runId: typeof session?.runId === "string" ? session.runId : "",
            scope: session?.scope === "planner" ? "planner" : "worker",
            taskId: typeof session?.taskId === "string" ? session.taskId : undefined,
            messages: Array.isArray(session?.messages) ? session.messages as StoredMessage[] : [],
            activeToolNames: uniqueStrings(
              Array.isArray(session?.activeToolNames)
                ? session.activeToolNames.filter((value): value is string => typeof value === "string")
                : [],
            ),
            progressLog: Array.isArray(session?.progressLog)
              ? session.progressLog.filter((value): value is string => typeof value === "string")
              : [],
            turns: Array.isArray(session?.turns)
              ? session.turns
                  .filter((turn): turn is WorkflowSessionTurnRecord => Boolean(turn && typeof turn === "object"))
                  .map((turn, index) => ({
                    index: typeof turn.index === "number" ? turn.index : index + 1,
                    startedAt: typeof turn.startedAt === "string" ? turn.startedAt : timestamp(),
                    completedAt: typeof turn.completedAt === "string" ? turn.completedAt : timestamp(),
                    modelId: typeof turn.modelId === "string" ? turn.modelId : undefined,
                    provider: typeof turn.provider === "string" ? turn.provider : undefined,
                    finishReason: typeof turn.finishReason === "string" ? turn.finishReason : "unknown",
                    rawFinishReason: typeof turn.rawFinishReason === "string" ? turn.rawFinishReason : undefined,
                    inputTokens: typeof turn.inputTokens === "number" ? turn.inputTokens : undefined,
                    outputTokens: typeof turn.outputTokens === "number" ? turn.outputTokens : undefined,
                    totalTokens: typeof turn.totalTokens === "number" ? turn.totalTokens : undefined,
                    responseToolNames: uniqueStrings(
                      Array.isArray(turn.responseToolNames)
                        ? turn.responseToolNames.filter((value): value is string => typeof value === "string")
                        : [],
                    ),
                    activeToolNames: uniqueStrings(
                      Array.isArray(turn.activeToolNames)
                        ? turn.activeToolNames.filter((value): value is string => typeof value === "string")
                        : [],
                    ),
                    visibleToolNames: uniqueStrings(
                      Array.isArray(turn.visibleToolNames)
                        ? turn.visibleToolNames.filter((value): value is string => typeof value === "string")
                        : [],
                    ),
                  }))
              : [],
            createdAt: typeof session?.createdAt === "string" ? session.createdAt : timestamp(),
            updatedAt: typeof session?.updatedAt === "string" ? session.updatedAt : timestamp(),
          } satisfies StoredWorkflowSessionState,
        ]),
      ),
    };
  }

  private writeStore(store: WorkflowSessionStoreShape) {
    assertTestRuntimeRootIsIsolated("Workflow session store");
    this.ensureStoreDir();
    fs.writeFileSync(this.storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  }

  private readArchiveStore(): WorkflowSessionArchiveStoreShape {
    this.ensureStoreDir();
    if (!fs.existsSync(this.archivePath)) {
      return {
        version: 1,
        entries: [],
      };
    }

    const parsed = JSON.parse(fs.readFileSync(this.archivePath, "utf8")) as Partial<WorkflowSessionArchiveStoreShape>;
    return {
      version: 1,
      entries: Array.isArray(parsed.entries)
        ? parsed.entries
            .filter((entry): entry is WorkflowSessionArchiveEntry => Boolean(entry && typeof entry === "object"))
            .map((entry) => ({
              runId: typeof entry.runId === "string" ? entry.runId : "",
              archivedAt: typeof entry.archivedAt === "string" ? entry.archivedAt : timestamp(),
              sessions: Array.isArray(entry.sessions) ? entry.sessions : [],
            }))
        : [],
    };
  }

  private appendArchiveEntry(entry: WorkflowSessionArchiveEntry) {
    const archive = this.readArchiveStore();
    archive.entries.push(entry);
    this.writeArchiveStore(archive);
  }

  private writeArchiveStore(store: WorkflowSessionArchiveStoreShape) {
    assertTestRuntimeRootIsIsolated("Workflow session archive store");
    this.ensureStoreDir();
    fs.writeFileSync(this.archivePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  }
}
