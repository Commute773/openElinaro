/**
 * Claude Agent SDK core implementation.
 *
 * Uses persistent SDK sessions (via ClaudeSdkSession) to keep a single
 * subprocess alive across conversational turns. The first turn creates
 * the session; subsequent turns reuse it for warm cache and lower latency.
 * Harness domain tools are registered via an in-process MCP server.
 * The SDK handles its own agent loop, compaction, context management,
 * streaming, file checkpointing, and thinking.
 */
import {
  tool,
  createSdkMcpServer,
  type Options,
  type SDKMessage,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSdkSession } from "./claude-sdk-session";
import { z } from "zod";
import { attemptOrAsync } from "../utils/result";
import { telemetry } from "../services/infrastructure/telemetry";
import type { AgentStreamEvent } from "../domain/assistant";
import type {
  CoreRunOptions,
  CoreRunResult,
  CoreAssistantMessage,
  CoreToolDefinition,
  CoreUsage,
} from "./types";

// ---------------------------------------------------------------------------
// Native tool and suppression lists
// ---------------------------------------------------------------------------

/**
 * Harness tool names that the Claude SDK handles natively.
 * The harness should NOT send these as tool definitions since the SDK
 * provides them internally.
 */
export const CLAUDE_SDK_NATIVE_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "exec_command",
  "web_search",
  "web_fetch",
]);

/**
 * Harness tool names that should not be provided to the SDK at all.
 * The SDK manages its own tool loading and compaction.
 */
export const CLAUDE_SDK_SUPPRESSED_TOOLS = new Set([
  "load_tool_library",
  "compact",
]);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ClaudeSdkCoreConfig {
  model: string;
  apiKey?: string;
  cwd?: string;
  /** Existing persistent session to reuse across turns. */
  session?: ClaudeSdkSession;
  /** SDK session ID to resume from disk when no live session handle is available. */
  resumeSessionId?: string;
  /** Internal retry counter — prevents infinite recursion on persistent errors. */
  _retryCount?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Choose the correct env var for the given API key/token.
 * OAuth setup tokens (sk-ant-oat*) → CLAUDE_CODE_OAUTH_TOKEN
 * Standard API keys → ANTHROPIC_API_KEY
 */
/**
 * Choose the correct env var for the given API key/token.
 * OAuth setup tokens (sk-ant-oat*) → CLAUDE_CODE_OAUTH_TOKEN
 * Standard API keys → ANTHROPIC_API_KEY
 */
export function buildAuthEnv(apiKey: string): Record<string, string> {
  if (apiKey.startsWith("sk-ant-oat")) {
    return { CLAUDE_CODE_OAUTH_TOKEN: apiKey };
  }
  return { ANTHROPIC_API_KEY: apiKey };
}

/**
 * Normalize a dated Claude model ID (e.g. "claude-opus-4-6-20260301") to the
 * alias form the Agent SDK expects (e.g. "claude-opus-4-6").
 * Non-Claude or already-alias IDs pass through unchanged.
 */
export function normalizeSdkModelId(modelId: string): string {
  return modelId.replace(/-(\d{8})$/, "");
}

const sdkCoreTelemetry = telemetry.child({ component: "claude_sdk_core" });

export class ClaudeSdkCore {
  constructor(private readonly config: ClaudeSdkCoreConfig) {}

  async run(options: CoreRunOptions): Promise<CoreRunResult> {
    const {
      systemPrompt,
      tools: harnessTools,
      executeTool,
      maxSteps,
      signal,
      onAssistantMessage,
      hooks: harnessHooks,
      onProgress,
    } = options;

    // Build MCP tools from harness tool definitions
    const mcpTools = harnessTools.map((toolDef) =>
      buildMcpTool(toolDef, executeTool),
    );

    const mcpServer = createSdkMcpServer({
      name: "openelinaro",
      tools: mcpTools,
    });

    // Build the tool allow-list so the SDK auto-approves MCP tools
    const allowedMcpTools = harnessTools.map(
      (t) => `mcp__openelinaro__${t.name}`,
    );

    // Build hooks
    const sdkHooks: Options["hooks"] = {};

    if (harnessHooks?.onPreCompact) {
      const preCompactHook: HookCallback = async () => {
        await harnessHooks.onPreCompact!("");
        return {};
      };
      sdkHooks.PreCompact = [{ hooks: [preCompactHook] }];
    }

    if (harnessHooks?.canUseTool) {
      const preToolUseHook: HookCallback = async (input) => {
        const preInput = input as { tool_name?: string; tool_input?: Record<string, unknown> };
        const allowed = harnessHooks.canUseTool!(
          preInput.tool_name ?? "",
          preInput.tool_input ?? {},
        );
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: allowed ? ("allow" as const) : ("deny" as const),
          },
        };
      };
      sdkHooks.PreToolUse = [{ hooks: [preToolUseHook] }];
    }

    if (onProgress) {
      const postToolUseHook: HookCallback = async (input) => {
        const postInput = input as { tool_name?: string; tool_use_id?: string };
        await onProgress({ type: "tool_end", name: postInput.tool_name ?? "unknown", isError: false });
        return {};
      };
      sdkHooks.PostToolUse = [{ hooks: [postToolUseHook] }];

      const postToolUseFailureHook: HookCallback = async (input) => {
        const postInput = input as { tool_name?: string; error?: string };
        await onProgress({ type: "tool_end", name: postInput.tool_name ?? "unknown", isError: true, error: postInput.error ?? "unknown error" });
        return {};
      };
      sdkHooks.PostToolUseFailure = [{ hooks: [postToolUseFailureHook] }];
    }

    // Extract the user prompt from the last user message
    const lastUserMsg = [...options.messages].reverse().find((m) => m.role === "user");
    const prompt = lastUserMsg
      ? typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : lastUserMsg.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n\n")
      : "";

    // Build SDK options — enable session persistence for cross-turn continuity
    const sdkOptions: Options = {
      model: normalizeSdkModelId(this.config.model),
      systemPrompt,
      cwd: this.config.cwd ?? process.cwd(),
      mcpServers: { openelinaro: mcpServer },
      allowedTools: [
        // Auto-approve all built-in tools + all MCP harness tools
        ...allowedMcpTools,
      ],
      disallowedTools: [
        // The harness owns these — SDK should not use its built-in versions
        "AskUserQuestion",
      ],
      tools: { type: "preset", preset: "claude_code" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: true,
      thinking: { type: "adaptive" },
      hooks: sdkHooks,
      ...(maxSteps ? { maxTurns: maxSteps } : {}),
      ...(this.config.apiKey
        ? { env: { ...process.env, ...buildAuthEnv(this.config.apiKey) } }
        : {}),
      ...(signal ? { abortController: abortControllerFromSignal(signal) } : {}),
    };

    // Wrap the external signal so we can abort programmatically (e.g. on first-message timeout)
    const wrappedController = signal ? abortControllerFromSignal(signal) : undefined;

    // Run the query
    const newMessages: CoreAssistantMessage[] = [];
    let finalText = "";
    let totalUsage: CoreUsage = emptyUsage();
    let steps = 0;
    let capturedSessionId: string | undefined;
    const onLog = options.onLog;

    const FIRST_MESSAGE_TIMEOUT_MS = 120_000;
    const MAX_RETRIES = 2;

    // Helper to emit progress without blocking the stream
    const progress = onProgress
      ? (event: AgentStreamEvent) => { void attemptOrAsync(() => onProgress(event), undefined); }
      : undefined;

    // Create or reuse the persistent session.
    // When resuming a dead session, pass the resume ID so the SDK restores
    // conversation context from its persisted JSONL transcript on disk.
    const sessionReused = !!this.config.session?.isAlive;
    const resumingFromDisk = !sessionReused && !!this.config.resumeSessionId;
    const session = sessionReused
      ? this.config.session!
      : ClaudeSdkSession.create(
          resumingFromDisk
            ? { ...sdkOptions, resume: this.config.resumeSessionId }
            : sdkOptions,
        );
    const runStartedAt = Date.now();

    sdkCoreTelemetry.event("claude_sdk_core.session_lifecycle", {
      action: sessionReused ? "reuse" : resumingFromDisk ? "resume" : "create",
      sessionId: session.sessionId,
      resumeSessionId: resumingFromDisk ? this.config.resumeSessionId : undefined,
      model: this.config.model,
      promptLength: prompt.length,
      toolCount: harnessTools.length,
    }, { level: "debug" });

    // Update MCP tools on reused sessions so the subprocess sees current tool definitions.
    if (sessionReused) {
      session.query.setMcpServers({ openelinaro: mcpServer });
    }

    // Push the user message to start this turn
    session.sendMessage(prompt);

    let receivedFirstMessage = false;

    const firstMessageTimer = setTimeout(() => {
      if (!receivedFirstMessage && !signal?.aborted) {
        sdkCoreTelemetry.event("claude_sdk_core.first_message_timeout", {
          sessionReused,
          sessionId: session.sessionId,
          sessionAlive: session.isAlive,
          elapsedMs: Date.now() - runStartedAt,
        }, { level: "warn", outcome: "error" });
        // The SDK is hanging — likely an auth or model error it didn't surface.
        // Abort via the wrapped controller so signal.aborted becomes true.
        wrappedController?.abort("first message timeout");
      }
    }, FIRST_MESSAGE_TIMEOUT_MS);

    try {
    try {
    while (true) {
      const { value: message, done } = await session.nextMessage();
      if (done) {
        sdkCoreTelemetry.event("claude_sdk_core.stream_ended", {
          sessionReused,
          sessionId: session.sessionId,
          receivedFirstMessage,
          steps,
          elapsedMs: Date.now() - runStartedAt,
        }, { level: "debug" });
        break;
      }
      if (!receivedFirstMessage) {
        receivedFirstMessage = true;
        sdkCoreTelemetry.event("claude_sdk_core.first_message", {
          sessionReused,
          sessionId: session.sessionId,
          messageType: message.type,
          elapsedMs: Date.now() - runStartedAt,
        }, { level: "debug" });
      }
      if (signal?.aborted) break;

      if (message.type === "assistant") {
        steps++;
        const usage = extractUsage(message);
        totalUsage = mergeUsage(totalUsage, usage);

        // Extract content blocks from the BetaMessage for logging
        const betaMsg = (message as any).message;
        const contentBlocks = betaMsg?.content ?? [];
        const textBlocks = contentBlocks.filter((b: any) => b.type === "text");
        const toolUseBlocks = contentBlocks.filter((b: any) => b.type === "tool_use");
        const thinkingBlocks = contentBlocks.filter((b: any) => b.type === "thinking");

        const coreMsg: CoreAssistantMessage = {
          role: "assistant",
          content: [
            ...thinkingBlocks.map((b: any) => ({
              type: "thinking" as const,
              thinking: b.thinking ?? "",
              thinkingSignature: b.signature,
            })),
            ...textBlocks.map((b: any) => ({
              type: "text" as const,
              text: b.text ?? "",
            })),
            ...toolUseBlocks.map((b: any) => ({
              type: "toolCall" as const,
              id: b.id ?? "",
              name: b.name ?? "",
              arguments: b.input ?? {},
            })),
          ],
          provider: "claude",
          model: this.config.model,
          responseId: betaMsg?.id,
          usage,
          stopReason: betaMsg?.stop_reason === "tool_use" ? "toolUse" : "stop",
          timestamp: Date.now(),
        };

        newMessages.push(coreMsg);
        onAssistantMessage?.(coreMsg);
        harnessHooks?.onUsage?.(usage);

        // Emit thinking blocks to surface
        if (progress && thinkingBlocks.length > 0) {
          for (const block of thinkingBlocks) {
            const thinking = (block as any).thinking ?? "";
            if (thinking) {
              const preview = thinking.length > 300 ? thinking.slice(0, 300) + "..." : thinking;
              progress({ type: "thinking", text: preview });
            }
          }
        }

        // Emit tool calls to surface
        if (progress && toolUseBlocks.length > 0) {
          for (const block of toolUseBlocks) {
            const name = (block as any).name ?? "unknown";
            const input = (block as any).input ?? {};
            progress({ type: "tool_start", name, args: input });
          }
        }

        onLog?.("sdk_assistant_message", {
          responseId: betaMsg?.id,
          step: steps,
          textBlockCount: textBlocks.length,
          toolUseBlockCount: toolUseBlocks.length,
          thinkingBlockCount: thinkingBlocks.length,
          toolNames: toolUseBlocks.map((b: any) => b.name),
          stopReason: betaMsg?.stop_reason,
          inputTokens: usage.input,
          outputTokens: usage.output,
        });
      }

      if (message.type === "tool_use_summary") {
        const summary = (message as any).summary as string;
        const toolUseIds = (message as any).preceding_tool_use_ids as string[];
        onLog?.("sdk_tool_use_summary", { summary, toolUseIds });
        progress?.({ type: "tool_summary", summary });
      }

      if (message.type === "tool_progress") {
        const msg = message as any;
        const toolName: string = msg.tool_name ?? "unknown";
        const elapsed: number = msg.elapsed_time_seconds ?? 0;
        onLog?.("sdk_tool_progress", {
          toolUseId: msg.tool_use_id,
          toolName,
          elapsed,
          taskId: msg.task_id,
        });
        progress?.({ type: "tool_progress", name: toolName, elapsed, taskId: msg.task_id });
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          finalText = message.result;
          totalUsage = extractResultUsage(message);
          const numTurns = (message as any).num_turns ?? 0;
          const durationMs = (message as any).duration_ms ?? 0;
          const totalCostUsd = (message as any).total_cost_usd ?? 0;
          onLog?.("sdk_result_success", {
            numTurns,
            durationMs,
            durationApiMs: (message as any).duration_api_ms,
            totalCostUsd,
            inputTokens: totalUsage.input,
            outputTokens: totalUsage.output,
            cacheReadTokens: totalUsage.cacheRead,
            resultChars: finalText.length,
          });
          progress?.({ type: "result", turns: numTurns, durationMs, costUsd: totalCostUsd });
          break; // Turn complete — session stays alive for next turn
        } else {
          const rawMessage = message as any;
          const errors = rawMessage.errors ?? [];
          const errorText = errors.length > 0 ? errors.join("; ") : "unknown";
          onLog?.("sdk_result_error", {
            error: errorText,
            subtype: rawMessage.subtype,
            // Log the full raw message for post-mortem diagnostics
            rawErrorCount: errors.length,
            hasResult: !!rawMessage.result,
            resultPreview: rawMessage.result ? String(rawMessage.result).slice(0, 200) : undefined,
            rawMessage: JSON.stringify(rawMessage).slice(0, 1000),
          });

          // Retry with a fresh session when the error is transient:
          // - Stale session errors (subprocess died, session expired)
          // - "unknown" (subprocess died without meaningful error)
          // - error_during_execution / ede_diagnostic (agent loop ended in unexpected state)
          const retryCount = this.config._retryCount ?? 0;
          const isEdeDiagnostic = rawMessage.subtype === "error_during_execution" || errorText.includes("[ede_diagnostic]");
          const isRecoverable = isStaleSessionError(new Error(errorText)) || errorText === "unknown" || isEdeDiagnostic;
          if (isRecoverable && retryCount < MAX_RETRIES && (this.config.session || resumingFromDisk)) {
            sdkCoreTelemetry.event("claude_sdk_core.error_result_retry", {
              sessionReused,
              resumingFromDisk,
              sessionId: session.sessionId,
              errorText,
              retryCount: retryCount + 1,
              elapsedMs: Date.now() - runStartedAt,
            }, { level: "warn" });
            onLog?.("sdk_session_died_retry", { error: errorText, retryCount: retryCount + 1 });
            progress?.({ type: "status", message: "Session error, retrying with fresh session" });
            session.close();
            const freshCore = new ClaudeSdkCore({ ...this.config, session: undefined, resumeSessionId: undefined, _retryCount: retryCount + 1 });
            return freshCore.run(options);
          }

          progress?.({ type: "error", message: errorText });
          throw new Error(`Claude Code returned an error result: ${errorText}`);
        }
      }

      if (message.type === "system") {
        const msg = message as any;
        const subtype: string = msg.subtype ?? "";
        onLog?.("sdk_system", { subtype, message: msg.message ?? msg.text ?? "" });

        switch (subtype) {
          case "init":
            capturedSessionId = msg.session_id ?? undefined;
            if (capturedSessionId) session.setSessionId(capturedSessionId);
            // agent_init is logged but not surfaced to users — it fires every turn
            break;
          case "api_retry":
            progress?.({ type: "status", message: `API retry: attempt ${msg.attempt ?? "?"}/${msg.max_retries ?? "?"}, waiting ${msg.retry_delay_ms ?? 0}ms${msg.error_status ? ` (HTTP ${msg.error_status})` : ""}` });
            break;
          case "compact_boundary": {
            const meta = msg.compact_metadata ?? {};
            progress?.({ type: "compaction", trigger: meta.trigger ?? "unknown", preTokens: meta.pre_tokens });
            break;
          }
          case "status":
            if (msg.status) {
              progress?.({ type: "status", message: msg.status });
            }
            break;
          case "local_command_output":
            if (msg.content) {
              const preview = msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content;
              progress?.({ type: "status", message: `Command output: ${preview}` });
            }
            break;
          case "hook_started":
            progress?.({ type: "status", message: `Hook started: ${msg.hook_name ?? "unknown"} (${msg.hook_event ?? "unknown"})` });
            break;
          case "hook_progress":
            if (msg.output) {
              progress?.({ type: "status", message: `Hook progress [${msg.hook_name ?? "unknown"}]: ${msg.output}` });
            }
            break;
          case "hook_response":
            progress?.({ type: "status", message: `Hook ${msg.outcome ?? "completed"}: ${msg.hook_name ?? "unknown"}${msg.exit_code != null ? ` (exit ${msg.exit_code})` : ""}` });
            break;
          case "task_started":
            progress?.({ type: "task_started", taskId: msg.task_id ?? "", description: msg.description, taskType: msg.task_type });
            break;
          case "task_progress": {
            const usage = msg.usage ?? {};
            progress?.({ type: "task_progress", taskId: msg.task_id ?? "", tokens: usage.total_tokens, toolUses: usage.tool_uses, durationMs: usage.duration_ms });
            break;
          }
          case "task_notification":
            progress?.({ type: "task_completed", taskId: msg.task_id ?? "", status: msg.status, summary: msg.summary });
            break;
          case "files_persisted": {
            const files = msg.files ?? [];
            const failed = msg.failed ?? [];
            progress?.({ type: "status", message: `Files persisted: ${files.length} saved${failed.length > 0 ? `, ${failed.length} failed` : ""}` });
            break;
          }
          case "session_state_changed":
            progress?.({ type: "status", message: `Session state: ${msg.state ?? "unknown"}` });
            break;
          case "elicitation_complete":
            progress?.({ type: "status", message: `Elicitation complete: ${msg.mcp_server_name ?? "unknown"}` });
            break;
        }
      }

      if (message.type === "rate_limit_event") {
        const info = (message as any).rate_limit_info ?? {};
        onLog?.("sdk_rate_limit", info);
        // Rate limit info is logged but not surfaced to users — it's noise
      }

      if (message.type === "auth_status") {
        const msg = message as any;
        onLog?.("sdk_auth_status", { isAuthenticating: msg.isAuthenticating, error: msg.error });
        if (msg.isAuthenticating) {
          progress?.({ type: "status", message: "Authenticating..." });
        } else if (msg.error) {
          progress?.({ type: "error", message: `Auth error: ${msg.error}` });
        }
      }

      if (message.type === "prompt_suggestion") {
        const suggestion = (message as any).suggestion ?? "";
        onLog?.("sdk_prompt_suggestion", { suggestion });
      }
    }
    } catch (err: unknown) {
      const elapsedMs = Date.now() - runStartedAt;
      sdkCoreTelemetry.event("claude_sdk_core.run_error", {
        sessionReused,
        sessionId: session.sessionId,
        sessionAlive: session.isAlive,
        receivedFirstMessage,
        steps,
        elapsedMs,
        error: err instanceof Error ? err.message : String(err),
        errorName: err instanceof Error ? err.name : "unknown",
        isAborted: signal?.aborted ?? false,
        abortReason: signal?.aborted ? String(signal.reason) : undefined,
      }, { level: "warn", outcome: "error" });

      const retryCount = this.config._retryCount ?? 0;
      // If we haven't received any messages yet and the session died,
      // close it and retry with a fresh session.
      if (!receivedFirstMessage && retryCount < MAX_RETRIES && this.config.session && isStaleSessionError(err)) {
        onLog?.("sdk_session_died_retry", { error: String(err), retryCount: retryCount + 1 });
        progress?.({ type: "status", message: "Session expired, starting fresh" });
        session.close();
        const freshCore = new ClaudeSdkCore({ ...this.config, session: undefined, resumeSessionId: undefined, _retryCount: retryCount + 1 });
        return freshCore.run(options);
      }
      // If resume from disk failed, fall back to a completely fresh session.
      if (!receivedFirstMessage && retryCount < MAX_RETRIES && resumingFromDisk) {
        sdkCoreTelemetry.event("claude_sdk_core.resume_failed_fallback", {
          resumeSessionId: this.config.resumeSessionId,
          error: err instanceof Error ? err.message : String(err),
          retryCount: retryCount + 1,
          elapsedMs: Date.now() - runStartedAt,
        }, { level: "warn" });
        onLog?.("sdk_resume_failed_fallback", { error: String(err), retryCount: retryCount + 1 });
        progress?.({ type: "status", message: "Session resume failed, starting fresh" });
        session.close();
        const freshCore = new ClaudeSdkCore({ ...this.config, session: undefined, resumeSessionId: undefined, _retryCount: retryCount + 1 });
        return freshCore.run(options);
      }
      throw err;
    }
    } finally {
      clearTimeout(firstMessageTimer);
    }

    if (!receivedFirstMessage && !signal?.aborted) {
      // If we reused a session that silently died (subprocess gone, no messages),
      // retry once with a fresh session instead of surfacing the error.
      const deadRetryCount = this.config._retryCount ?? 0;
      if (sessionReused && this.config.session && deadRetryCount < MAX_RETRIES) {
        sdkCoreTelemetry.event("claude_sdk_core.dead_session_retry", {
          sessionId: session.sessionId,
          sessionAlive: session.isAlive,
          retryCount: deadRetryCount + 1,
          elapsedMs: Date.now() - runStartedAt,
        }, { level: "warn" });
        session.close();
        const freshCore = new ClaudeSdkCore({ ...this.config, session: undefined, _retryCount: deadRetryCount + 1 });
        return freshCore.run(options);
      }
      throw new Error("Claude Agent SDK timed out waiting for the first response. This usually means an auth or model configuration error.");
    }

    // Build the final assistant message
    const finalMessage: CoreAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: finalText }],
      provider: "claude",
      model: this.config.model,
      usage: totalUsage,
      stopReason: "stop",
      timestamp: Date.now(),
    };

    return {
      newMessages: [finalMessage],
      finalMessage,
      steps,
      totalUsage,
      sdkSessionId: capturedSessionId,
      sessionHandle: session,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMcpTool(
  toolDef: CoreToolDefinition,
  executeTool: CoreRunOptions["executeTool"],
) {
  // Extract the Zod schema shape for the SDK's tool() function.
  // The SDK expects ZodRawShape — the .shape of a z.object().
  // If the original Zod schema is available and is a ZodObject, use its shape directly.
  // Otherwise fall back to a passthrough schema.
  const zodSchema = toolDef.zodSchema;
  const shape = zodSchema instanceof z.ZodObject
    ? (zodSchema as z.ZodObject<z.ZodRawShape>).shape
    : { input: z.string().optional().describe("JSON-encoded tool arguments") };
  const useFallback = !(zodSchema instanceof z.ZodObject);

  return tool(
    toolDef.name,
    toolDef.description,
    shape,
    async (args) => {
      // When using the fallback schema, parse the JSON string input.
      // When using the real schema, args are already parsed by Zod.
      const parsedArgs = useFallback && typeof args.input === "string"
        ? JSON.parse(args.input)
        : args;
      const result = await executeTool(
        {
          type: "toolCall",
          id: `mcp-${toolDef.name}-${Date.now()}`,
          name: toolDef.name,
          arguments: parsedArgs,
        },
      );
      const text = result.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return {
        content: [{ type: "text" as const, text: text || "(no output)" }],
        isError: result.isError,
      };
    },
  );
}

function extractUsage(message: SDKMessage & { type: "assistant" }): CoreUsage {
  const u = (message as any).message?.usage;
  if (!u) return emptyUsage();
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function extractResultUsage(message: SDKMessage & { type: "result"; subtype: "success" }): CoreUsage {
  const u = (message as any).usage;
  const totalCost = (message as any).total_cost_usd ?? 0;
  if (!u) return emptyUsage();
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
  };
}

function emptyUsage(): CoreUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function mergeUsage(a: CoreUsage, b: CoreUsage): CoreUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

/** Detect errors from the SDK indicating a stale/expired session or dead subprocess. */
function isStaleSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no conversation found|session.*not found|invalid.*session|session.*expired|process aborted|aborted by user/i.test(msg);
}

function abortControllerFromSignal(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller;
}
