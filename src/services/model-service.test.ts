import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, test } from "bun:test";
import type { ProfileRecord } from "../domain/profiles";
import type { ActiveModelSelection } from "./model-service";
import { ModelService, resolveListedModelIdentifier, resolveRuntimeModelIdentifier } from "./model-service";
import { UsageTrackingService } from "./usage-tracking-service";

const TEST_PROFILE: ProfileRecord = {
  id: "test-profile",
  name: "Test Profile",
  roles: ["root"],
  memoryNamespace: "test",
};

function createSelection(
  overrides: Partial<ActiveModelSelection>,
): ActiveModelSelection {
  return {
    providerId: "openai-codex",
    modelId: "gpt-5.4",
    thinkingLevel: "low",
    extendedContextEnabled: false,
    updatedAt: "2026-03-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("ModelService.getInferenceOptions", () => {
  test("does not attach payload mutation for Codex extended context", () => {
    const service = new ModelService(TEST_PROFILE);

    expect(service.getInferenceOptions(createSelection({
      extendedContextEnabled: true,
    }))).toEqual({
      reasoningEffort: "low",
    });
  });

  test("maps Claude minimal thinking to disabled thinking", () => {
    const service = new ModelService(TEST_PROFILE);

    expect(service.getInferenceOptions(createSelection({
      providerId: "claude",
      modelId: "claude-sonnet-4-5",
      thinkingLevel: "minimal",
    }))).toEqual({
      thinkingEnabled: false,
    });
  });

  test("maps Claude xhigh thinking to max effort", () => {
    const service = new ModelService(TEST_PROFILE);

    expect(service.getInferenceOptions(createSelection({
      providerId: "claude",
      modelId: "claude-sonnet-4-5",
      thinkingLevel: "xhigh",
    }))).toEqual({
      thinkingEnabled: true,
      effort: "max",
    });
  });
});

describe("ModelService.getActiveModel", () => {
  test("uses the profile default thinking level when no stored selection exists", () => {
    const previousCwd = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-model-service-"));
    process.chdir(tempRoot);

    try {
      const service = new ModelService({
        ...TEST_PROFILE,
        defaultThinkingLevel: "high",
      });

      expect(service.getActiveModel()).toMatchObject({
        providerId: "openai-codex",
        modelId: "gpt-5.4",
        thinkingLevel: "high",
      });
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("supports a separate subagent default model selection scope", () => {
    const previousCwd = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-model-service-"));
    process.chdir(tempRoot);

    try {
      const interactive = new ModelService({
        ...TEST_PROFILE,
        preferredProvider: "claude",
        defaultModelId: "claude-opus-4-6-20260301",
        subagentPreferredProvider: "openai-codex",
        subagentDefaultModelId: "gpt-5.4",
      });
      const subagent = new ModelService({
        ...TEST_PROFILE,
        preferredProvider: "claude",
        defaultModelId: "claude-opus-4-6-20260301",
        subagentPreferredProvider: "openai-codex",
        subagentDefaultModelId: "gpt-5.4",
      }, {
        selectionStoreKey: "test-profile:subagent",
        defaultSelectionOverride: {
          providerId: "openai-codex",
          modelId: "gpt-5.4",
        },
      });

      expect(interactive.getActiveModel()).toMatchObject({
        providerId: "claude",
        modelId: "claude-opus-4-6-20260301",
      });
      expect(subagent.getActiveModel()).toMatchObject({
        providerId: "openai-codex",
        modelId: "gpt-5.4",
      });
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("supports a separate subagent default thinking level override", () => {
    const previousCwd = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-model-service-"));
    process.chdir(tempRoot);

    try {
      const subagent = new ModelService({
        ...TEST_PROFILE,
        defaultThinkingLevel: "low",
      }, {
        selectionStoreKey: "test-profile:subagent",
        defaultSelectionOverride: {
          thinkingLevel: "high",
        },
      });

      expect(subagent.getActiveModel()).toMatchObject({
        thinkingLevel: "high",
      });
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("caps the active context window when the profile defines an artificial max", () => {
    const service = new ModelService({
      ...TEST_PROFILE,
      maxContextTokens: 200_000,
      preferredProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
    });

    expect(service.getActiveExtendedContextStatus()).toMatchObject({
      activeContextWindow: 200_000,
    });
  });
});

describe("ModelService.getToolSummarizerSelection", () => {
  test("defaults Claude profiles to Haiku 4.5", () => {
    const service = new ModelService({
      ...TEST_PROFILE,
      preferredProvider: "claude",
    });

    expect(service.getToolSummarizerSelection()).toEqual({
      providerId: "claude",
      modelId: "claude-haiku-4-5",
      thinkingLevel: "minimal",
    });
  });

  test("defaults Codex profiles to GPT-5.1 Codex Mini", () => {
    const service = new ModelService({
      ...TEST_PROFILE,
      preferredProvider: "openai-codex",
    });

    expect(service.getToolSummarizerSelection()).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.1-codex-mini",
      thinkingLevel: "minimal",
    });
  });

  test("uses explicit profile overrides when present", () => {
    const service = new ModelService({
      ...TEST_PROFILE,
      preferredProvider: "claude",
      toolSummarizerProvider: "openai-codex",
      toolSummarizerModelId: "gpt-5.4",
    });

    expect(service.getToolSummarizerSelection()).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "minimal",
    });
  });
});

describe("ModelService.getMemorySelection", () => {
  test("defaults memory selection to the tool summarizer defaults", () => {
    const service = new ModelService({
      ...TEST_PROFILE,
      preferredProvider: "claude",
      toolSummarizerProvider: "claude",
      toolSummarizerModelId: "claude-haiku-4-5",
    });

    expect(service.getMemorySelection()).toEqual({
      providerId: "claude",
      modelId: "claude-haiku-4-5",
      thinkingLevel: "minimal",
    });
  });

  test("uses explicit memory profile overrides when present", () => {
    const service = new ModelService({
      ...TEST_PROFILE,
      preferredProvider: "claude",
      toolSummarizerProvider: "claude",
      toolSummarizerModelId: "claude-haiku-4-5",
      memoryProvider: "openai-codex",
      memoryModelId: "gpt-5.4",
    });

    expect(service.getMemorySelection()).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "minimal",
    });
  });
});

describe("resolveListedModelIdentifier", () => {
  test("resolves human Claude model labels to the canonical live id", () => {
    const resolved = resolveListedModelIdentifier("opus 4 6", [
      {
        providerId: "claude",
        modelId: "claude-opus-4-6-20260301",
        name: "Claude Opus 4.6",
        supported: true,
        active: false,
      },
      {
        providerId: "claude",
        modelId: "claude-sonnet-4-5-20260210",
        name: "Claude Sonnet 4.5",
        supported: true,
        active: false,
      },
    ]);

    expect(resolved.modelId).toBe("claude-opus-4-6-20260301");
  });

  test("prefers supported matches when multiple aliases overlap", () => {
    const resolved = resolveListedModelIdentifier("sonnet 4 5", [
      {
        providerId: "claude",
        modelId: "claude-sonnet-4-5-20260210",
        name: "Claude Sonnet 4.5",
        supported: true,
        active: false,
      },
      {
        providerId: "claude",
        modelId: "claude-sonnet-4-5-preview",
        name: "Claude Sonnet 4.5 Preview",
        supported: false,
        active: false,
      },
    ]);

    expect(resolved.modelId).toBe("claude-sonnet-4-5-20260210");
  });
});

describe("resolveRuntimeModelIdentifier", () => {
  test("maps a dated Claude provider id onto the runtime alias", () => {
    const resolved = resolveRuntimeModelIdentifier("claude-opus-4-6-20260301", [
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
      },
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
      },
    ]);

    expect(resolved?.id).toBe("claude-opus-4-6");
  });

  test("returns the exact runtime model when it already matches", () => {
    const resolved = resolveRuntimeModelIdentifier("claude-opus-4-6", [
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
      },
    ]);

    expect(resolved?.id).toBe("claude-opus-4-6");
  });
});

describe("ModelService.inspectContextWindowUsage", () => {
  test("uses the resolved Claude runtime model id for provider token counting", async () => {
    const service = new ModelService(TEST_PROFILE);
    let countedModelId = "";

    (service as any).resolveActiveRuntimeModel = async () => ({
      selection: createSelection({
        providerId: "claude",
        modelId: "claude-opus-4-6-20260301",
      }),
      runtimeModel: {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      apiKey: "test-api-key",
    });
    (service as any).countAnthropicTokens = async (params: { modelId: string }) => {
      countedModelId = params.modelId;
      return 1_234;
    };

    const usage = await service.inspectContextWindowUsage({
      conversationKey: "conversation-1",
      systemPrompt: "You are a test system prompt.",
      messages: [new HumanMessage("hello")],
      tools: [],
    });

    expect(countedModelId).toBe("claude-opus-4-6");
    expect(usage.modelId).toBe("claude-opus-4-6-20260301");
    expect(usage.usedTokens).toBe(1_234);
    expect(usage.method).toBe("provider_count");
  });

  test("applies the profile artificial max context cap to usage budgeting", async () => {
    const service = new ModelService({
      ...TEST_PROFILE,
      maxContextTokens: 200_000,
    });

    (service as any).resolveActiveRuntimeModel = async () => ({
      selection: createSelection({
        providerId: "openai-codex",
        modelId: "gpt-5.4",
      }),
      runtimeModel: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        contextWindow: 272_000,
        maxTokens: 8_192,
      },
      apiKey: "test-api-key",
    });

    const usage = await service.inspectContextWindowUsage({
      conversationKey: "conversation-1",
      systemPrompt: "You are a test system prompt.",
      messages: [new HumanMessage("hello")],
      tools: [],
    });

    expect(usage.maxContextTokens).toBe(200_000);
  });
});

describe("ModelService recorded usage inspection", () => {
  test("scopes model usage inspection to the active profile", () => {
    const previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-model-usage-inspection-"));
    process.env.OPENELINARO_ROOT_DIR = tempRoot;

    try {
      const usageTracking = new UsageTrackingService();
      usageTracking.record({
        profileId: TEST_PROFILE.id,
        providerId: "openai-codex",
        modelId: "gpt-5.4",
        sessionId: "session-root",
        conversationKey: "conversation-1",
        purpose: "chat_turn",
        nonCachedInputTokens: 100,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        inputTokens: 115,
        outputTokens: 25,
        totalTokens: 140,
        cost: {
          input: 0.01,
          output: 0.02,
          cacheRead: 0.001,
          cacheWrite: 0.0005,
          total: 0.0315,
        },
      });
      usageTracking.record({
        profileId: "other-profile",
        providerId: "openai-codex",
        modelId: "gpt-5.4",
        sessionId: "session-other",
        conversationKey: "conversation-2",
        purpose: "chat_turn",
        nonCachedInputTokens: 9_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputTokens: 9_000,
        outputTokens: 900,
        totalTokens: 9_900,
        cost: {
          input: 0.9,
          output: 0.3,
          cacheRead: 0,
          cacheWrite: 0,
          total: 1.2,
        },
      });

      const service = new ModelService(TEST_PROFILE, { usageTracking });
      const inspection = service.inspectRecordedUsage({
        conversationKey: "conversation-1",
        providerId: "openai-codex",
        modelId: "gpt-5.4",
      });

      expect(inspection.conversation.requestCount).toBe(1);
      expect(inspection.conversation.totalTokens).toBe(140);
      expect(inspection.conversation.cost.total).toBe(0.0315);
      expect(inspection.model.requestCount).toBe(1);
      expect(inspection.model.totalTokens).toBe(140);
      expect(inspection.model.cost.total).toBe(0.0315);
    } finally {
      if (previousRootDirEnv === undefined) {
        delete process.env.OPENELINARO_ROOT_DIR;
      } else {
        process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("summarizes local-day usage for the active profile and conversation", () => {
    const previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-model-usage-day-"));
    process.env.OPENELINARO_ROOT_DIR = tempRoot;

    try {
      const usageTracking = new UsageTrackingService();
      usageTracking.record({
        id: "root-day-1",
        createdAt: "2026-03-18T13:00:00.000Z",
        profileId: TEST_PROFILE.id,
        providerId: "openai-codex",
        modelId: "gpt-5.4",
        sessionId: "session-root",
        conversationKey: "conversation-1",
        purpose: "chat_turn",
        nonCachedInputTokens: 120,
        cacheReadTokens: 15,
        cacheWriteTokens: 0,
        inputTokens: 135,
        outputTokens: 30,
        totalTokens: 165,
        cost: {
          input: 0.012,
          output: 0.021,
          cacheRead: 0.001,
          cacheWrite: 0,
          total: 0.034,
        },
        providerBudgetRemaining: 750_000,
        providerBudgetSource: "provider",
      });
      usageTracking.record({
        id: "root-day-2",
        createdAt: "2026-03-18T20:00:00.000Z",
        profileId: TEST_PROFILE.id,
        providerId: "openai-codex",
        modelId: "gpt-5.4",
        sessionId: "session-root-2",
        conversationKey: "conversation-3",
        purpose: "chat_turn",
        nonCachedInputTokens: 80,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        inputTokens: 95,
        outputTokens: 20,
        totalTokens: 115,
        cost: {
          input: 0.008,
          output: 0.014,
          cacheRead: 0.0005,
          cacheWrite: 0.0005,
          total: 0.023,
        },
      });
      usageTracking.record({
        id: "other-profile-day",
        createdAt: "2026-03-18T14:00:00.000Z",
        profileId: "other-profile",
        providerId: "openai-codex",
        modelId: "gpt-5.4",
        sessionId: "session-other",
        conversationKey: "conversation-other",
        purpose: "chat_turn",
        nonCachedInputTokens: 9_999,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputTokens: 9_999,
        outputTokens: 999,
        totalTokens: 10_998,
        cost: {
          input: 1,
          output: 0.4,
          cacheRead: 0,
          cacheWrite: 0,
          total: 1.4,
        },
      });

      const service = new ModelService(TEST_PROFILE, { usageTracking });
      const inspection = service.inspectRecordedUsageByLocalDate({
        conversationKey: "conversation-1",
        providerId: "openai-codex",
        modelId: "gpt-5.4",
        localDate: "2026-03-18",
        timezone: "America/Montreal",
      });

      expect(inspection.localDate).toBe("2026-03-18");
      expect(inspection.conversation.requestCount).toBe(1);
      expect(inspection.conversation.cost.total).toBe(0.034);
      expect(inspection.profileDay.requestCount).toBe(2);
      expect(inspection.profileDay.totalTokens).toBe(280);
      expect(inspection.profileDay.cost.total).toBe(0.057);
      expect(inspection.modelDay.requestCount).toBe(2);
      expect(inspection.latestConversationRecord?.id).toBe("root-day-1");
      expect(inspection.latestProfileDayRecord?.id).toBe("root-day-2");
      expect(inspection.latestModelDayRecord?.id).toBe("root-day-2");
      expect(inspection.providerBudgetRemaining).toBe(750_000);
      expect(inspection.providerBudgetSource).toBe("provider");
    } finally {
      if (previousRootDirEnv === undefined) {
        delete process.env.OPENELINARO_ROOT_DIR;
      } else {
        process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("ModelService.countAnthropicTokens", () => {
  test("serializes multimodal user messages with Anthropic image sources", async () => {
    const service = new ModelService(TEST_PROFILE);
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ input_tokens: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const tokens = await (service as any).countAnthropicTokens({
        modelId: "claude-opus-4-6",
        apiKey: "test-claude-token",
        systemPrompt: "You are a test system prompt.",
        messages: [
          new HumanMessage([
            { type: "text", text: "What is in this image?" },
            {
              type: "image",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO0pQn8AAAAASUVORK5CYII=",
              mimeType: "image/png",
            },
          ]),
        ],
        tools: [],
      });

      expect(tokens).toBe(42);
      expect(requestBody).toMatchObject({
        model: "claude-opus-4-6",
        system: "You are a test system prompt.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO0pQn8AAAAASUVORK5CYII=",
                },
              },
            ],
          },
        ],
        tools: [],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves concrete WebP mime types in Anthropic image sources", async () => {
    const service = new ModelService(TEST_PROFILE);
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ input_tokens: 12 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await (service as any).countAnthropicTokens({
        modelId: "claude-opus-4-6",
        apiKey: "test-claude-token",
        systemPrompt: "You are a test system prompt.",
        messages: [
          new HumanMessage([
            { type: "text", text: "What is in this image?" },
            {
              type: "image",
              data: "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoIAAgAAkA4JaQAA3AA/vuUAAA=",
              mimeType: "image/webp",
            },
          ]),
        ],
        tools: [],
      });

      expect(requestBody).toMatchObject({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/webp",
                  data: "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoIAAgAAkA4JaQAA3AA/vuUAAA=",
                },
              },
            ],
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("always uses inline base64 for Anthropic token counting even when sourceUrl is present", async () => {
    const service = new ModelService(TEST_PROFILE);
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ input_tokens: 9 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await (service as any).countAnthropicTokens({
        modelId: "claude-opus-4-6",
        apiKey: "test-claude-token",
        systemPrompt: "You are a test system prompt.",
        messages: [
          new HumanMessage([
            { type: "text", text: "What is in this image?" },
            {
              type: "image",
              data: "base64data",
              mimeType: "image/png",
              sourceUrl: "https://cdn.discordapp.com/attachments/example.png",
            },
          ]),
        ],
        tools: [],
      });

      expect(requestBody).toMatchObject({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "base64data",
                },
              },
            ],
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
