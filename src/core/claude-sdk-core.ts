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
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

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

    // Build SDK options
    const sdkOptions: Options = {
      model: this.config.model,
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
      persistSession: false,
      thinking: { type: "adaptive" },
      hooks: sdkHooks,
      ...(maxSteps ? { maxTurns: maxSteps } : {}),
      ...(this.config.apiKey
        ? {
            env: {
              ...process.env,
              ...(this.config.apiKey.startsWith("sk-ant-oat")
                ? { CLAUDE_CODE_OAUTH_TOKEN: this.config.apiKey }
                : { ANTHROPIC_API_KEY: this.config.apiKey }),
            },
          }
        : {}),
      ...(signal ? { abortController: abortControllerFromSignal(signal) } : {}),
    };

    // Run the query
    const newMessages: CoreAssistantMessage[] = [];
    let finalText = "";
    let totalUsage: CoreUsage = emptyUsage();
    let steps = 0;
    const onLog = options.onLog;

    const queryStream = query({ prompt, options: sdkOptions });

    for await (const message of queryStream) {
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
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          finalText = message.result;
          totalUsage = extractResultUsage(message);
          onLog?.("sdk_result_success", {
            numTurns: (message as any).num_turns,
            durationMs: (message as any).duration_ms,
            durationApiMs: (message as any).duration_api_ms,
            totalCostUsd: (message as any).total_cost_usd,
            inputTokens: totalUsage.input,
            outputTokens: totalUsage.output,
            cacheReadTokens: totalUsage.cacheRead,
            resultChars: finalText.length,
          });
        } else {
          onLog?.("sdk_result_error", {
            error: (message as any).error ?? "unknown",
          });
        }
      }

      if (message.type === "system") {
        onLog?.("sdk_system", {
          message: (message as any).message ?? (message as any).text ?? "",
        });
      }
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

function abortControllerFromSignal(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller;
}
