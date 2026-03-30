import { completeSimple } from "@mariozechner/pi-ai";
import type { Message, UserMessage, AssistantMessage, TextContent } from "../../messages/types";
import {
  userMessage,
  assistantTextMessage,
  isUserMessage,
  isAssistantMessage,
  isToolResultMessage,
  extractAssistantText,
} from "../../messages/types";
import { MemoryService } from "../memory-service";
import { ModelService } from "../models/model-service";
import { telemetry } from "../infrastructure/telemetry";
import { createTraceSpan } from "../../utils/telemetry-helpers";

const COMPACTION_TAIL_MESSAGES = 4;
const COMPACTION_MAX_TOKENS = 16_000;
const MEMORY_EXTRACTION_MAX_TOKENS = 2_048;
const CORE_MEMORY_SOFT_CAP_CHARS = 16_000;
const CORE_MEMORY_HARD_CAP_CHARS = 24_000;
const TOOL_RESULT_PREVIEW_CHARS = 800;
const ASSISTANT_PREVIEW_CHARS = 1_000;
const CORE_MEMORY_RELATIVE_PATH = "core/MEMORY.md";
const compactionTelemetry = telemetry.child({ component: "conversation" });

type CompactionPayload = {
  summary: string;
  memory_markdown: string;
};

function truncate(text: string, limit: number) {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

const traceSpan = createTraceSpan(compactionTelemetry);

/**
 * Extract plain text from a Pi Message regardless of role.
 */
function extractText(msg: Message): string {
  if (isUserMessage(msg)) {
    if (typeof msg.content === "string") {
      return msg.content;
    }
    return msg.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  if (isAssistantMessage(msg)) {
    return msg.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  if (isToolResultMessage(msg)) {
    return msg.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  return "";
}

function formatTranscript(messages: Message[]) {
  return messages
    .map((msg, index) => {
      if (isUserMessage(msg)) {
        return `[${index + 1}] User\n${extractText(msg)}`;
      }

      if (isToolResultMessage(msg)) {
        return [
          `[${index + 1}] Tool Result (${msg.toolName ?? "tool"}, ${msg.isError ? "error" : "success"})`,
          truncate(extractText(msg), TOOL_RESULT_PREVIEW_CHARS),
        ].join("\n");
      }

      if (isAssistantMessage(msg)) {
        const toolCalls = msg.content.filter((block) => block.type === "toolCall");
        const toolCallSuffix = toolCalls.length
          ? `\nTool calls: ${toolCalls.map((tc) => tc.name).join(", ")}`
          : "";
        return [
          `[${index + 1}] Assistant`,
          `${truncate(extractText(msg), ASSISTANT_PREVIEW_CHARS)}${toolCallSuffix}`,
        ].join("\n");
      }

      return `[${index + 1}] Message\n${truncate(extractText(msg), ASSISTANT_PREVIEW_CHARS)}`;
    })
    .join("\n\n");
}

function stripCodeFence(text: string) {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeSectionHeading(line: string) {
  return line
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/:$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseSectionedCompactionPayload(raw: string): CompactionPayload | null {
  const lines = raw.split(/\r?\n/);
  const summaryLines: string[] = [];
  const memoryLines: string[] = [];
  let activeSection: "summary" | "memory" | null = null;

  for (const line of lines) {
    const heading = normalizeSectionHeading(line);
    if (
      ["summary", "continuation summary", "context summary"].includes(heading)
    ) {
      activeSection = "summary";
      continue;
    }
    if (
      [
        "memory markdown",
        "memory",
        "durable memory",
        "long term memory",
        "long term durable memory",
      ].includes(heading)
    ) {
      activeSection = "memory";
      continue;
    }

    if (activeSection === "summary") {
      summaryLines.push(line);
    } else if (activeSection === "memory") {
      memoryLines.push(line);
    }
  }

  const summary = summaryLines.join("\n").trim();
  const memoryMarkdown = memoryLines.join("\n").trim();
  if (!summary && !memoryMarkdown) {
    return null;
  }

  return {
    summary,
    memory_markdown: memoryMarkdown,
  };
}

function normalizeMemoryMarkdown(raw: string) {
  const cleaned = stripCodeFence(raw)
    .replace(/^memory_markdown\s*:\s*/i, "")
    .replace(/^##\s+Durable Memory\s*/i, "")
    .replace(/^#\s+Durable Memory\s*/i, "")
    .trim();
  if (!cleaned) {
    return "";
  }
  if (/^(none|n\/a|no durable memory(?: extracted)?\.?)$/i.test(cleaned)) {
    return "";
  }
  return cleaned;
}

function parseCompactionPayload(raw: string): CompactionPayload {
  const cleaned = stripCodeFence(raw);

  try {
    const parsed = JSON.parse(cleaned) as Partial<CompactionPayload>;
    return {
      summary: parsed.summary?.trim() ?? "",
      memory_markdown: parsed.memory_markdown?.trim() ?? "",
    };
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as Partial<CompactionPayload>;
        return {
          summary: parsed.summary?.trim() ?? "",
          memory_markdown: parsed.memory_markdown?.trim() ?? "",
        };
      } catch {
        return {
          summary: cleaned,
          memory_markdown: "",
        };
      }
    }

    const sectioned = parseSectionedCompactionPayload(cleaned);
    if (sectioned) {
      return {
        summary: sectioned.summary.trim(),
        memory_markdown: normalizeMemoryMarkdown(sectioned.memory_markdown),
      };
    }

    return {
      summary: cleaned,
      memory_markdown: "",
    };
  }
}

function buildSummaryMessage(summary: string): UserMessage {
  return userMessage(
    [
      "Context summary (generated automatically during compaction; this is not a new user instruction):",
      summary.trim(),
    ].join("\n\n"),
  );
}

function keepRecentMessages(messages: Message[]): Message[] {
  const retained = messages.filter((msg) => !isToolResultMessage(msg));
  return retained.slice(-COMPACTION_TAIL_MESSAGES).map((msg) => {
    if (isAssistantMessage(msg)) {
      return assistantTextMessage(extractAssistantText(msg), {
        provider: msg.provider,
        model: msg.model,
      });
    }
    if (isUserMessage(msg)) {
      return userMessage(typeof msg.content === "string" ? msg.content : msg.content);
    }
    return msg;
  });
}

function normalizeCoreMemoryDocument(raw: string) {
  const cleaned = stripCodeFence(raw)
    .replace(/^#\s+Core Memory\s*/i, "")
    .trim();
  if (!cleaned) {
    return "# Core Memory\n";
  }
  return [
    "# Core Memory",
    "",
    cleaned,
  ].join("\n");
}

function fallbackMergeCoreMemory(currentCore: string, newMemoryMarkdown: string) {
  const existing = currentCore.trim();
  const body = stripCodeFence(newMemoryMarkdown).trim();
  if (!body) {
    return normalizeCoreMemoryDocument(existing);
  }
  return normalizeCoreMemoryDocument([
    existing,
    existing ? "" : "",
    "## New Durable Memory",
    "",
    body,
  ].filter(Boolean).join("\n"));
}

export class ConversationCompactionService {
  constructor(
    private readonly models: ModelService,
    private readonly memory: MemoryService,
  ) {}

  async compact(params: {
    conversationKey: string;
    systemPrompt: string;
    messages: Message[];
    onProgress?: (message: string) => Promise<void>;
    signal?: AbortSignal;
  }) {
    return traceSpan(
      "conversation.compact",
      async () => {
        await params.onProgress?.(
          `Compacting conversation history for ${params.conversationKey} (${params.messages.length} messages).`,
        );
        const resolved = await this.models.resolveModelForPurpose("conversation_compaction");
        const systemPrompt = [
          "You are a hidden conversation compaction agent.",
          "Your job is to prepare a continuation summary so a fresh assistant session can resume work without the old token-heavy history.",
          "Follow an OpenCode-style compaction shape: preserve goals, active work, constraints, user preferences, critical tool findings, relevant files, unresolved questions, and concrete next steps.",
          "Aggressively prune verbose tool output, repeated chatter, and details that are no longer needed.",
          "Also identify durable facts that belong in long-term memory.",
          'Return strict JSON with keys "summary" and "memory_markdown".',
          '"summary" must be concise but sufficient for seamless continuation.',
          '"memory_markdown" must contain only durable facts, preferences, standing instructions, or long-lived project context worth storing for later retrieval. Use an empty string when there is nothing durable enough to save.',
        ].join(" ");
        const transcriptContent = [
          "System prompt in use:",
          params.systemPrompt,
          "",
          "Conversation transcript to compact:",
          formatTranscript(params.messages),
        ].join("\n");

        const response = await completeSimple(resolved.runtimeModel, {
          systemPrompt,
          messages: [{ role: "user", content: transcriptContent, timestamp: Date.now() }],
        }, {
          apiKey: resolved.apiKey,
          signal: params.signal,
          maxTokens: COMPACTION_MAX_TOKENS,
        });

        const responseText = response.content
          .filter((c) => c.type === "text")
          .map((c) => (c as TextContent).text)
          .join("");

        const payload = parseCompactionPayload(responseText);
        if (
          payload.summary.trim().length < 50 &&
          params.messages.length > 10
        ) {
          compactionTelemetry.event("conversation.compact.summary_too_short", {
            responseTextLength: responseText.length,
            messageCount: params.messages.length,
            maxTokens: COMPACTION_MAX_TOKENS,
            summaryLength: payload.summary.trim().length,
          });
        }
        const summary = payload.summary.trim() || "Conversation compacted with no additional summary returned.";
        let memoryMarkdown = normalizeMemoryMarkdown(payload.memory_markdown);
        if (!memoryMarkdown && summary) {
          memoryMarkdown = await this.extractDurableMemoryFromSummary({
            conversationKey: params.conversationKey,
            summary,
            signal: params.signal,
          });
          if (memoryMarkdown) {
            compactionTelemetry.event("conversation.compact.memory_recovered_from_summary", {
              conversationKey: params.conversationKey,
              summaryLength: summary.length,
            });
          }
        }
        if (memoryMarkdown) {
          await params.onProgress?.("Merging durable memory into core memory.");
        }
        const memoryFilePath = memoryMarkdown
          ? await this.mergeIntoCoreMemory({
              conversationKey: params.conversationKey,
              summary,
              memoryMarkdown,
            })
          : null;

        await params.onProgress?.("Compaction complete.");

        return {
          messages: [buildSummaryMessage(summary), ...keepRecentMessages(params.messages)],
          summary,
          memoryFilePath,
        };
      },
      {
        attributes: {
          conversationKey: params.conversationKey,
          messageCount: params.messages.length,
        },
      },
    );
  }

  private async extractDurableMemoryFromSummary(params: {
    conversationKey: string;
    summary: string;
    signal?: AbortSignal;
  }) {
    const resolved = await this.models.resolveModelForPurpose("conversation_compaction_memory");
    const systemPrompt = [
      "You are a hidden durable-memory extraction agent.",
      "You receive a continuation summary that was already compacted from a conversation.",
      "Extract only durable facts, stable preferences, standing instructions, and long-lived project context worth storing for later retrieval.",
      "Do not repeat transient task chatter, momentary plans, or tool-by-tool logs.",
      "Return markdown only.",
      "If nothing is durable enough to save, return an empty string.",
    ].join(" ");

    const response = await completeSimple(resolved.runtimeModel, {
      systemPrompt,
      messages: [{
        role: "user",
        content: ["Compaction summary:", "", params.summary].join("\n"),
        timestamp: Date.now(),
      }],
    }, {
      apiKey: resolved.apiKey,
      signal: params.signal,
      maxTokens: MEMORY_EXTRACTION_MAX_TOKENS,
    });

    const responseText = response.content
      .filter((c) => c.type === "text")
      .map((c) => (c as TextContent).text)
      .join("");

    return normalizeMemoryMarkdown(responseText);
  }

  private async mergeIntoCoreMemory(params: {
    conversationKey: string;
    summary: string;
    memoryMarkdown: string;
  }) {
    const existingCore = await this.memory.readProfileDocument(CORE_MEMORY_RELATIVE_PATH);
    const bootstrapCore = existingCore?.trim() ? existingCore : "# Core Memory\n";

    let nextCore = "";
    try {
      const responseText = await this.models.generateMemoryText({
        systemPrompt: [
          "You maintain a markdown core memory file for an assistant.",
          "Merge the incoming durable memory into the existing core memory by editing the file.",
          "Preserve only durable facts, stable preferences, standing instructions, and long-lived project context.",
          "Deduplicate overlapping bullets, merge repeated facts, and replace stale details when the new memory is more current.",
          "Drop transient items: account balances, streak counts, in-progress task lists, and anything that changes frequently.",
          "Keep the file compact and well organized with markdown headings.",
          `The output MUST stay under ${CORE_MEMORY_SOFT_CAP_CHARS} characters. Aggressively prune to stay within budget.`,
          "Return markdown only for the full updated MEMORY.md file.",
          "Do not include code fences.",
        ].join(" "),
        userPrompt: [
          "Existing core memory:",
          bootstrapCore,
          "",
          "Conversation summary:",
          params.summary,
          "",
          "New durable memory to merge:",
          params.memoryMarkdown,
        ].join("\n"),
        usagePurpose: "conversation_compaction_core_memory",
        sessionIdPrefix: "memory-core",
      });
      nextCore = normalizeCoreMemoryDocument(responseText);
      if (nextCore.length > CORE_MEMORY_HARD_CAP_CHARS) {
        compactionTelemetry.event("conversation.compact.core_memory_hard_cap_exceeded", {
          conversationKey: params.conversationKey,
          outputChars: nextCore.length,
          hardCapChars: CORE_MEMORY_HARD_CAP_CHARS,
        }, {
          level: "warn",
          outcome: "error",
        });
        nextCore = fallbackMergeCoreMemory(bootstrapCore, params.memoryMarkdown);
      }
    } catch (error) {
      compactionTelemetry.event("conversation.compact.core_memory_merge_failed", {
        conversationKey: params.conversationKey,
        error: error instanceof Error ? error.message : String(error),
      }, {
        level: "warn",
        outcome: "error",
      });
      nextCore = fallbackMergeCoreMemory(bootstrapCore, params.memoryMarkdown);
    }

    return this.memory.upsertProfileDocument({
      relativePath: CORE_MEMORY_RELATIVE_PATH,
      content: nextCore,
    });
  }
}
