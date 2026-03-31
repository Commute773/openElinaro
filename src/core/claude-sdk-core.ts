/**
 * Claude Agent SDK core implementation.
 *
 * Uses the Claude Agent SDK's query() API to run the agent loop.
 * Harness domain tools are registered via an in-process MCP server.
 * The SDK handles its own agent loop, compaction, context management,
 * streaming, file checkpointing, and thinking.
 */
import {
  query,
  tool,
  createSdkMcpServer,
  type Options,
  type SDKMessage,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  AgentCore,
  CoreManifest,
  CoreRunOptions,
  CoreRunResult,
  CoreAssistantMessage,
  CoreToolDefinition,
  CoreUsage,
  CoreModelConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Claude Agent SDK native tools — these overlap with harness tools.
 * The harness should NOT send these as tool definitions since the SDK
 * provides them natively.
 */
export const CLAUDE_SDK_MANIFEST: CoreManifest = {
  id: "claude-sdk",

  nativeTools: [
    { harnessToolName: "read_file",    coreToolName: "Read",      reportResultsToHarness: false },
    { harnessToolName: "write_file",   coreToolName: "Write",     reportResultsToHarness: false },
    { harnessToolName: "edit_file",    coreToolName: "Edit",      reportResultsToHarness: false },
    { harnessToolName: "glob",         coreToolName: "Glob",      reportResultsToHarness: false },
    { harnessToolName: "grep",         coreToolName: "Grep",      reportResultsToHarness: false },
    { harnessToolName: "exec_command", coreToolName: "Bash",      reportResultsToHarness: true },
    { harnessToolName: "web_search",   coreToolName: "WebSearch", reportResultsToHarness: false },
    { harnessToolName: "web_fetch",    coreToolName: "WebFetch",  reportResultsToHarness: false },
  ],

  // The SDK manages its own tool loading; harness tool libraries are not applicable.
  suppressedTools: ["load_tool_library"],

  nativeFeatures: [
    { feature: "agent_loop",               mode: "core_owns" },
    { feature: "compaction",               mode: "shared", integrationPoint: "PreCompact hook" },
    { feature: "context_management",       mode: "core_owns" },
    { feature: "session_persistence",      mode: "shared", integrationPoint: "PostToolUse hook + message stream" },
    { feature: "cost_tracking",            mode: "shared", integrationPoint: "usage from message stream" },
    { feature: "streaming",                mode: "core_owns" },
    { feature: "permission_control",       mode: "shared", integrationPoint: "canUseTool callback" },
    { feature: "file_checkpointing",       mode: "core_owns" },
    { feature: "thinking",                 mode: "core_owns" },
    { feature: "tool_result_summarization", mode: "core_owns" },
  ],

  requires: {
    systemPrompt: true,
    messageHistory: false, // SDK manages its own session history
    toolExecution: true,   // Harness domain tools executed via MCP
    toolDefinitions: true, // Harness provides domain tool schemas
  },
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ClaudeSdkCoreConfig {
  model: string;
  apiKey?: string;
  cwd?: string;
  /** SDK session ID to resume from a prior turn (enables cross-turn continuity). */
  resumeSessionId?: string;
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

export class ClaudeSdkCore implements AgentCore {
  readonly manifest = CLAUDE_SDK_MANIFEST;

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
        await onProgress(`Tool completed: ${postInput.tool_name ?? "unknown"}`);
        return {};
      };
      sdkHooks.PostToolUse = [{ hooks: [postToolUseHook] }];

      const postToolUseFailureHook: HookCallback = async (input) => {
        const postInput = input as { tool_name?: string; error?: string };
        await onProgress(`Tool failed: ${postInput.tool_name ?? "unknown"} — ${postInput.error ?? "unknown error"}`);
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
      ...(this.config.resumeSessionId
        ? { resume: this.config.resumeSessionId }
        : {}),
    };

    // Run the query
    const newMessages: CoreAssistantMessage[] = [];
    let finalText = "";
    let totalUsage: CoreUsage = emptyUsage();
    let steps = 0;
    let capturedSessionId: string | undefined;
    const onLog = options.onLog;

    const FIRST_MESSAGE_TIMEOUT_MS = 120_000;
    const queryStream = query({ prompt, options: sdkOptions });
    let receivedFirstMessage = false;

    const firstMessageTimer = setTimeout(() => {
      if (!receivedFirstMessage && !signal?.aborted) {
        // The SDK is hanging — likely an auth or model error it didn't surface.
        // Abort so the error propagates instead of hanging forever.
        signal?.dispatchEvent?.(new Event("abort"));
      }
    }, FIRST_MESSAGE_TIMEOUT_MS);

    // Helper to emit progress without blocking the stream
    const progress = onProgress
      ? (msg: string) => { onProgress(msg).catch(() => {}); }
      : undefined;

    try {
    for await (const message of queryStream) {
      receivedFirstMessage = true;
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
              progress(`Thinking: ${preview}`);
            }
          }
        }

        // Emit tool calls to surface
        if (progress && toolUseBlocks.length > 0) {
          for (const block of toolUseBlocks) {
            const name = (block as any).name ?? "unknown";
            const input = (block as any).input ?? {};
            const inputSummary = summarizeToolInput(name, input);
            progress(`Using tool: ${name}${inputSummary ? ` — ${inputSummary}` : ""}`);
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
        progress?.(`Tool summary: ${summary}`);
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
        progress?.(`Running ${toolName}... (${elapsed.toFixed(0)}s)`);
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
          progress?.(`Completed in ${numTurns} turns, ${(durationMs / 1000).toFixed(1)}s, $${totalCostUsd.toFixed(4)}`);
        } else {
          const errors = (message as any).errors ?? [];
          const errorText = errors.length > 0 ? errors.join("; ") : "unknown";
          onLog?.("sdk_result_error", { error: errorText, subtype: message.subtype });
          progress?.(`Error: ${errorText}`);
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
            progress?.(`Agent initialized: model=${msg.model ?? "unknown"}, ${(msg.tools ?? []).length} tools, ${(msg.mcp_servers ?? []).length} MCP servers`);
            break;
          case "api_retry":
            progress?.(`API retry: attempt ${msg.attempt ?? "?"}/${msg.max_retries ?? "?"}, waiting ${msg.retry_delay_ms ?? 0}ms${msg.error_status ? ` (HTTP ${msg.error_status})` : ""}`);
            break;
          case "compact_boundary": {
            const meta = msg.compact_metadata ?? {};
            progress?.(`Conversation compacted (trigger: ${meta.trigger ?? "unknown"}, pre-tokens: ${meta.pre_tokens ?? "?"})`);
            break;
          }
          case "status":
            if (msg.status) {
              progress?.(`Status: ${msg.status}`);
            }
            break;
          case "local_command_output":
            if (msg.content) {
              const preview = msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content;
              progress?.(`Command output: ${preview}`);
            }
            break;
          case "hook_started":
            progress?.(`Hook started: ${msg.hook_name ?? "unknown"} (${msg.hook_event ?? "unknown"})`);
            break;
          case "hook_progress":
            if (msg.output) {
              progress?.(`Hook progress [${msg.hook_name ?? "unknown"}]: ${msg.output}`);
            }
            break;
          case "hook_response":
            progress?.(`Hook ${msg.outcome ?? "completed"}: ${msg.hook_name ?? "unknown"}${msg.exit_code != null ? ` (exit ${msg.exit_code})` : ""}`);
            break;
          case "task_started":
            progress?.(`Task started: ${msg.description ?? msg.task_id ?? "unknown"}${msg.task_type ? ` (${msg.task_type})` : ""}`);
            break;
          case "task_progress": {
            const usage = msg.usage ?? {};
            progress?.(`Task progress: ${msg.description ?? msg.task_id ?? "unknown"} (${usage.total_tokens ?? 0} tokens, ${usage.tool_uses ?? 0} tool calls, ${((usage.duration_ms ?? 0) / 1000).toFixed(1)}s)`);
            break;
          }
          case "task_notification":
            progress?.(`Task ${msg.status ?? "completed"}: ${msg.summary ?? msg.task_id ?? "unknown"}`);
            break;
          case "files_persisted": {
            const files = msg.files ?? [];
            const failed = msg.failed ?? [];
            progress?.(`Files persisted: ${files.length} saved${failed.length > 0 ? `, ${failed.length} failed` : ""}`);
            break;
          }
          case "session_state_changed":
            progress?.(`Session state: ${msg.state ?? "unknown"}`);
            break;
          case "elicitation_complete":
            progress?.(`Elicitation complete: ${msg.mcp_server_name ?? "unknown"}`);
            break;
        }
      }

      if (message.type === "rate_limit_event") {
        const info = (message as any).rate_limit_info ?? {};
        onLog?.("sdk_rate_limit", info);
        progress?.(`Rate limited — ${JSON.stringify(info)}`);
      }

      if (message.type === "auth_status") {
        const msg = message as any;
        onLog?.("sdk_auth_status", { isAuthenticating: msg.isAuthenticating, error: msg.error });
        if (msg.isAuthenticating) {
          progress?.("Authenticating...");
        } else if (msg.error) {
          progress?.(`Auth error: ${msg.error}`);
        }
      }

      if (message.type === "prompt_suggestion") {
        const suggestion = (message as any).suggestion ?? "";
        onLog?.("sdk_prompt_suggestion", { suggestion });
      }
    }
    } finally {
      clearTimeout(firstMessageTimer);
    }

    if (!receivedFirstMessage && !signal?.aborted) {
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

/** Produce a short human-readable summary of a tool's input for progress display. */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
      return input.file_path ? String(input.file_path) : "";
    case "Write":
      return input.file_path ? String(input.file_path) : "";
    case "Edit":
      return input.file_path ? String(input.file_path) : "";
    case "Glob":
      return input.pattern ? String(input.pattern) : "";
    case "Grep":
      return input.pattern ? `/${input.pattern}/` : "";
    case "Bash": {
      const cmd = String(input.command ?? "");
      return cmd.length > 120 ? cmd.slice(0, 120) + "..." : cmd;
    }
    case "WebSearch":
      return input.query ? String(input.query) : "";
    case "WebFetch":
      return input.url ? String(input.url) : "";
    case "Agent":
      return input.description ? String(input.description) : "";
    default: {
      // For MCP tools, show the first string-valued arg
      for (const [key, val] of Object.entries(input)) {
        if (typeof val === "string" && val.length > 0 && val.length < 200) {
          return `${key}: ${val}`;
        }
      }
      return "";
    }
  }
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
