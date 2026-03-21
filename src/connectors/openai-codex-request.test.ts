import { describe, expect, test } from "bun:test";
import { stream, type Context, type Model } from "@mariozechner/pi-ai";
import type { ProfileRecord } from "../domain/profiles";
import type { ActiveModelSelection } from "../services/model-service";
import { ModelService } from "../services/model-service";

const TEST_PROFILE: ProfileRecord = {
  id: "test-profile",
  name: "Test Profile",
  roles: ["root"],
  memoryNamespace: "test",
};

const CODEX_MODEL: Model<"openai-codex-responses"> = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 272_000,
  maxTokens: 32_768,
};

const BASE_SELECTION: ActiveModelSelection = {
  providerId: "openai-codex",
  modelId: "gpt-5.4",
  thinkingLevel: "low",
  extendedContextEnabled: true,
  updatedAt: "2026-03-12T00:00:00.000Z",
};

function buildCodexToken() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
      },
      https: {
        api: {
          openai: {
            com: {
              auth: {
                chatgpt_account_id: "acct_test",
              },
            },
          },
        },
      },
    }),
    "signature",
  ].join(".");
}

async function captureRequestBody(
  selection: ActiveModelSelection = BASE_SELECTION,
): Promise<Record<string, unknown>> {
  const service = new ModelService(TEST_PROFILE);
  let capturedBody: Record<string, unknown> | null = null;

  const context: Context = {
    systemPrompt: "You are a test system prompt.",
    messages: [
      {
        role: "user",
        content: "Say hello.",
        timestamp: Date.now(),
      },
    ],
  };

  const responseStream = stream(CODEX_MODEL, context, {
    apiKey: buildCodexToken(),
    sessionId: "session:test",
    ...service.getInferenceOptions(selection),
    onPayload: (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Expected provider payload to be an object.");
      }
      capturedBody = payload as Record<string, unknown>;
      throw new Error("captured test payload");
    },
  });

  await responseStream.result();

  expect(capturedBody).not.toBeNull();
  return capturedBody ?? {};
}

describe("Codex request contract", () => {
  test("does not send unsupported extended-context payload fields", async () => {
    const body = await captureRequestBody();

    expect(body).toMatchObject({
      model: "gpt-5.4",
      store: false,
      stream: true,
      prompt_cache_key: "session:test",
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: {
        effort: "low",
        summary: "auto",
      },
    });
    expect(body).not.toHaveProperty("model_context_window");
    expect(body).not.toHaveProperty("model_auto_compact_token_limit");
  });
});
