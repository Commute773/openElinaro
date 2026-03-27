import {
  getModels,
  stream,
  type Context,
  type Message,
  type Model,
  type Api,
  type Usage,
} from "@mariozechner/pi-ai";
import { assertSuccessfulProviderResponse } from "../connectors/provider-response";
import type { ProfileRecord } from "../domain/profiles";
import { telemetry } from "./telemetry";
import { createTraceSpan } from "../utils/telemetry-helpers";
import { timestamp } from "../utils/timestamp";
import {
  PROVIDER_RUNTIME_MAP,
  getSelectedContextWindow,
  resolveCodexApiKey,
  resolveClaudeToken,
  resolveRuntimeModelIdentifier,
  type ActiveModelSelection,
  type HeartbeatModelSelection,
  type MemoryModelSelection,
  type ModelProviderId,
  type ToolSummarizerSelection,
} from "./model-service";

const secondaryTelemetry = telemetry.child({ component: "secondary_model" });
const traceSpan = createTraceSpan(secondaryTelemetry);

const DEFAULT_ACTIVE_MODEL_PROVIDER_ID: ModelProviderId = "openai-codex";

const DEFAULT_TOOL_SUMMARIZER_MODEL_IDS: Record<ModelProviderId, string> = {
  "openai-codex": "gpt-5.1-codex-mini",
  claude: "claude-haiku-4-5",
};

const DEFAULT_HEARTBEAT_MODEL_IDS: Record<ModelProviderId, string> = {
  "openai-codex": "gpt-5.1-codex-mini",
  claude: "claude-haiku-4-5",
};

type ActiveModelInferenceOptions = ({
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  thinkingEnabled?: never;
  thinkingBudgetTokens?: never;
  effort?: never;
} | {
  reasoningEffort?: never;
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
  effort?: "low" | "medium" | "high" | "max";
});

export interface ResolvedRuntimeModel {
  selection: ActiveModelSelection;
  runtimeModel: Model<Api>;
  apiKey: string;
}

interface UsageRecorder {
  recordUsage(params: {
    providerId: ModelProviderId;
    modelId: string;
    sessionId: string;
    purpose: string;
    usage: Usage;
    providerReportedUsage?: Usage;
  }): void;
}

export class SecondaryModelDispatch {
  constructor(
    private readonly profile: ProfileRecord,
    private readonly usageRecorder: UsageRecorder,
  ) {}

  getToolSummarizerSelection(): ToolSummarizerSelection {
    const providerId = this.profile.toolSummarizerProvider ??
      this.profile.preferredProvider ??
      DEFAULT_ACTIVE_MODEL_PROVIDER_ID;
    return {
      providerId,
      modelId: this.profile.toolSummarizerModelId ?? DEFAULT_TOOL_SUMMARIZER_MODEL_IDS[providerId],
      thinkingLevel: "minimal",
    };
  }

  getMemorySelection(): MemoryModelSelection {
    const providerId = this.profile.memoryProvider ??
      this.profile.toolSummarizerProvider ??
      this.profile.preferredProvider ??
      DEFAULT_ACTIVE_MODEL_PROVIDER_ID;
    return {
      providerId,
      modelId: this.profile.memoryModelId ??
        this.profile.toolSummarizerModelId ??
        DEFAULT_TOOL_SUMMARIZER_MODEL_IDS[providerId],
      thinkingLevel: "minimal",
    };
  }

  getHeartbeatSelection(): HeartbeatModelSelection {
    const providerId = this.profile.heartbeatProvider ??
      this.profile.preferredProvider ??
      DEFAULT_ACTIVE_MODEL_PROVIDER_ID;
    return {
      providerId,
      modelId: this.profile.heartbeatModelId ?? DEFAULT_HEARTBEAT_MODEL_IDS[providerId],
      thinkingLevel: "low",
    };
  }

  getInferenceOptions(selection: ActiveModelSelection): ActiveModelInferenceOptions {
    if (selection.providerId === "claude") {
      if (selection.thinkingLevel === "minimal") {
        return {
          thinkingEnabled: false,
        };
      }

      return {
        thinkingEnabled: true,
        effort: selection.thinkingLevel === "xhigh" ? "max" : selection.thinkingLevel,
      };
    }

    return {
      reasoningEffort: selection.thinkingLevel,
    };
  }

  async resolveRuntimeModelForSelection(
    selection: ActiveModelSelection,
  ): Promise<ResolvedRuntimeModel> {
    const runtimeProvider = PROVIDER_RUNTIME_MAP[selection.providerId];
    const runtimeModels = getModels(runtimeProvider);
    const runtimeModel = resolveRuntimeModelIdentifier(selection.modelId, runtimeModels);
    if (!runtimeModel) {
      throw new Error(
        `The active model ${selection.providerId}/${selection.modelId} is not supported by the runtime.`,
      );
    }

    return {
      selection,
      runtimeModel: {
        ...runtimeModel,
        contextWindow: getSelectedContextWindow(this.profile, selection, runtimeModel.contextWindow) ??
          runtimeModel.contextWindow,
      },
      apiKey: await this.resolveApiKeyForProvider(selection.providerId),
    };
  }

  async resolveApiKeyForProvider(providerId: ModelProviderId) {
    if (providerId === "claude") {
      return resolveClaudeToken(this.profile.id);
    }

    const { apiKey } = await resolveCodexApiKey(this.profile.id);
    return apiKey;
  }

  async resolveActiveRuntimeModel(
    getActiveModel: () => Promise<ActiveModelSelection>,
  ): Promise<ResolvedRuntimeModel> {
    const selection = await getActiveModel();
    return this.resolveRuntimeModelForSelection(selection);
  }

  async resolveModelForPurpose(
    getActiveModel: () => Promise<ActiveModelSelection>,
    purpose?: string,
  ): Promise<ResolvedRuntimeModel> {
    if (purpose?.startsWith("automation_heartbeat")) {
      const heartbeat = this.getHeartbeatSelection();
      const selection: ActiveModelSelection = {
        providerId: heartbeat.providerId,
        modelId: heartbeat.modelId,
        thinkingLevel: heartbeat.thinkingLevel,
        extendedContextEnabled: false,
        updatedAt: new Date(0).toISOString(),
      };
      return this.resolveRuntimeModelForSelection(selection);
    }
    return this.resolveActiveRuntimeModel(getActiveModel);
  }

  async summarizeToolResult(params: {
    toolName: string;
    goal: string;
    output: string;
  }) {
    const selection = this.getToolSummarizerSelection();
    return traceSpan(
      "model.summarize_tool_result",
      async () => {
        const runtimeSelection: ActiveModelSelection = {
          ...selection,
          extendedContextEnabled: false,
          updatedAt: timestamp(),
        };
        const resolved = await this.resolveRuntimeModelForSelection(runtimeSelection);
        const context: Context = {
          systemPrompt: [
            "You compress raw tool output for another agent.",
            "Answer only the requested summary goal using the provided tool output.",
            "If the output does not contain enough evidence, return exactly: insufficient evidence",
            "Return plain text only.",
            "Be brief.",
          ].join(" "),
          messages: [
            {
              role: "user",
              content: [
                `Tool: ${params.toolName}`,
                `Goal: ${params.goal.trim()}`,
                "",
                "Tool output:",
                params.output,
              ].join("\n"),
              timestamp: Date.now(),
            } satisfies Message,
          ],
        };
        const sessionId = `tool-summarizer:${this.profile.id}:${Date.now()}`;
        const responseStream = stream(resolved.runtimeModel, context, {
          apiKey: resolved.apiKey,
          sessionId,
          ...this.getInferenceOptions(resolved.selection),
        });
        const response = assertSuccessfulProviderResponse(await responseStream.result(), {
          connector: "tool-summarizer",
          sessionId,
          usagePurpose: "tool_result_summarization",
        });
        this.usageRecorder.recordUsage({
          providerId: resolved.selection.providerId,
          modelId: response.model ?? resolved.selection.modelId,
          sessionId,
          purpose: "tool_result_summarization",
          usage: response.usage,
          providerReportedUsage: response.usage,
        });
        const text = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
          .trim();
        return text || "insufficient evidence";
      },
      {
        attributes: {
          profileId: this.profile.id,
          providerId: selection.providerId,
          modelId: selection.modelId,
          toolName: params.toolName,
          goalLength: params.goal.length,
          outputLength: params.output.length,
        },
      },
    );
  }

  async generateMemoryText(params: {
    systemPrompt: string;
    userPrompt: string;
    usagePurpose: string;
    sessionIdPrefix?: string;
  }) {
    const selection = this.getMemorySelection();
    return traceSpan(
      "model.generate_memory_text",
      async () => {
        const runtimeSelection: ActiveModelSelection = {
          ...selection,
          extendedContextEnabled: false,
          updatedAt: timestamp(),
        };
        const resolved = await this.resolveRuntimeModelForSelection(runtimeSelection);
        const context: Context = {
          systemPrompt: params.systemPrompt,
          messages: [{
            role: "user",
            content: params.userPrompt,
            timestamp: Date.now(),
          } satisfies Message],
        };
        const sessionId = `${params.sessionIdPrefix?.trim() || "memory"}:${this.profile.id}:${Date.now()}`;
        const responseStream = stream(resolved.runtimeModel, context, {
          apiKey: resolved.apiKey,
          sessionId,
          ...this.getInferenceOptions(resolved.selection),
        });
        const response = assertSuccessfulProviderResponse(await responseStream.result(), {
          connector: "memory-model",
          sessionId,
          usagePurpose: params.usagePurpose,
        });
        this.usageRecorder.recordUsage({
          providerId: resolved.selection.providerId,
          modelId: response.model ?? resolved.selection.modelId,
          sessionId,
          purpose: params.usagePurpose,
          usage: response.usage,
          providerReportedUsage: response.usage,
        });
        return response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
          .trim();
      },
      {
        attributes: {
          profileId: this.profile.id,
          providerId: selection.providerId,
          modelId: selection.modelId,
          usagePurpose: params.usagePurpose,
          userPromptLength: params.userPrompt.length,
        },
      },
    );
  }
}
