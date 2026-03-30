import { test, expect, describe } from "bun:test";
import {
  piUserMessageToCore,
  piAssistantMessageToCore,
  piToolCallToCore,
  piToolResultMessageToCore,
  piMessageToCore,
  piMessagesToCore,
  piToolToCoreDef,
  coreMessageToPi,
  coreMessagesToPi,
  coreAssistantMessageToPi,
  coreUserMessageToPi,
  coreToolResultMessageToPi,
  coreToolCallToPi,
} from "./message-bridge.ts";
import type {
  UserMessage as PiUserMessage,
  AssistantMessage as PiAssistantMessage,
  ToolResultMessage as PiToolResultMessage,
  ToolCall as PiToolCall,
  Tool as PiTool,
} from "@mariozechner/pi-ai";
import type { CoreAssistantMessage, CoreUserMessage, CoreToolResultMessage } from "./types.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const baseUsage = {
  input: 100,
  output: 50,
  cacheRead: 10,
  cacheWrite: 5,
  totalTokens: 165,
  cost: { input: 0.01, output: 0.005, cacheRead: 0.001, cacheWrite: 0.0005, total: 0.0165 },
};

// ---------------------------------------------------------------------------
// piUserMessageToCore
// ---------------------------------------------------------------------------

describe("piUserMessageToCore", () => {
  test("converts string content", () => {
    const piMsg: PiUserMessage = { role: "user", content: "Hello", timestamp: 1000 };
    const result = piUserMessageToCore(piMsg);
    expect(result.role).toBe("user");
    expect(result.content).toBe("Hello");
    expect(result.timestamp).toBe(1000);
  });

  test("converts array content with text and image", () => {
    const piMsg: PiUserMessage = {
      role: "user",
      content: [
        { type: "text", text: "Look at this" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      timestamp: 2000,
    };
    const result = piUserMessageToCore(piMsg);
    expect(result.role).toBe("user");
    expect(Array.isArray(result.content)).toBe(true);
    const arr = result.content as Array<{ type: string }>;
    expect(arr).toHaveLength(2);
    expect(arr[0]!.type).toBe("text");
    expect(arr[1]!.type).toBe("image");
  });

  test("handles empty array content", () => {
    const piMsg: PiUserMessage = { role: "user", content: [], timestamp: 3000 };
    const result = piUserMessageToCore(piMsg);
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// piAssistantMessageToCore
// ---------------------------------------------------------------------------

describe("piAssistantMessageToCore", () => {
  test("converts text content and drops api field", () => {
    const piMsg: PiAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hi there" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      usage: baseUsage,
      stopReason: "stop",
      timestamp: 1000,
    };
    const result = piAssistantMessageToCore(piMsg);
    expect(result.role).toBe("assistant");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.usage).toEqual(baseUsage);
    expect(result.stopReason).toBe("stop");
    // Should not carry the api field
    expect("api" in result).toBe(false);
  });

  test("preserves tool calls in content", () => {
    const piMsg: PiAssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "I'll read that file" },
        { type: "toolCall", id: "tc1", name: "read_file", arguments: { path: "/tmp/test" } },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      usage: baseUsage,
      stopReason: "toolUse",
      timestamp: 2000,
    };
    const result = piAssistantMessageToCore(piMsg);
    expect(result.content).toHaveLength(2);
    const toolCall = result.content[1]!;
    expect(toolCall.type).toBe("toolCall");
    if (toolCall.type === "toolCall") {
      expect(toolCall.name).toBe("read_file");
      expect(toolCall.arguments).toEqual({ path: "/tmp/test" });
    }
  });

  test("preserves thinking blocks", () => {
    const piMsg: PiAssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me consider...", thinkingSignature: "sig123" },
        { type: "text", text: "Here is my answer" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      usage: baseUsage,
      stopReason: "stop",
      timestamp: 3000,
    };
    const result = piAssistantMessageToCore(piMsg);
    expect(result.content).toHaveLength(2);
    const thinking = result.content[0]!;
    expect(thinking.type).toBe("thinking");
    if (thinking.type === "thinking") {
      expect(thinking.thinking).toBe("Let me consider...");
      expect(thinking.thinkingSignature).toBe("sig123");
    }
  });

  test("preserves optional fields (responseId, errorMessage)", () => {
    const piMsg: PiAssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4",
      responseId: "resp-123",
      usage: baseUsage,
      stopReason: "error",
      errorMessage: "rate limit exceeded",
      timestamp: 4000,
    };
    const result = piAssistantMessageToCore(piMsg);
    expect(result.responseId).toBe("resp-123");
    expect(result.errorMessage).toBe("rate limit exceeded");
  });
});

// ---------------------------------------------------------------------------
// piToolCallToCore
// ---------------------------------------------------------------------------

describe("piToolCallToCore", () => {
  test("maps id, name, and arguments", () => {
    const tc: PiToolCall = {
      type: "toolCall",
      id: "call_abc",
      name: "search",
      arguments: { query: "test", limit: 10 },
    };
    const result = piToolCallToCore(tc);
    expect(result.type).toBe("toolCall");
    expect(result.id).toBe("call_abc");
    expect(result.name).toBe("search");
    expect(result.arguments).toEqual({ query: "test", limit: 10 });
  });

  test("preserves thoughtSignature when present", () => {
    const tc: PiToolCall = {
      type: "toolCall",
      id: "call_def",
      name: "write_file",
      arguments: { path: "/tmp/x" },
      thoughtSignature: "thought-sig",
    };
    const result = piToolCallToCore(tc);
    expect(result.thoughtSignature).toBe("thought-sig");
  });
});

// ---------------------------------------------------------------------------
// piToolResultMessageToCore
// ---------------------------------------------------------------------------

describe("piToolResultMessageToCore", () => {
  test("converts tool result message", () => {
    const piMsg: PiToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_abc",
      toolName: "read_file",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: 5000,
    };
    const result = piToolResultMessageToCore(piMsg);
    expect(result.role).toBe("toolResult");
    expect(result.toolCallId).toBe("call_abc");
    expect(result.toolName).toBe("read_file");
    expect(result.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// coreMessageToPi — round-trip
// ---------------------------------------------------------------------------

describe("coreMessageToPi", () => {
  test("round-trips user message", () => {
    const piUser: PiUserMessage = { role: "user", content: "test", timestamp: 100 };
    const core = piUserMessageToCore(piUser);
    const roundTripped = coreMessageToPi(core);
    expect(roundTripped).toEqual(piUser);
  });

  test("round-trips assistant message with default api", () => {
    const piAssistant: PiAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      usage: baseUsage,
      stopReason: "stop",
      timestamp: 200,
    };
    const core = piAssistantMessageToCore(piAssistant);
    const roundTripped = coreMessageToPi(core);
    // api defaults to "unknown" since core drops it
    expect(roundTripped.role).toBe("assistant");
    if (roundTripped.role === "assistant") {
      expect(roundTripped.api).toBe("unknown");
    }
  });

  test("round-trips assistant message with custom api", () => {
    const piAssistant: PiAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4",
      usage: baseUsage,
      stopReason: "stop",
      timestamp: 300,
    };
    const core = piAssistantMessageToCore(piAssistant);
    const roundTripped = coreMessageToPi(core, "openai-completions");
    if (roundTripped.role === "assistant") {
      expect(roundTripped.api).toBe("openai-completions");
    }
  });

  test("round-trips tool result message", () => {
    const piResult: PiToolResultMessage = {
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "test_tool",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 400,
    };
    const core = piToolResultMessageToCore(piResult);
    const roundTripped = coreMessageToPi(core);
    expect(roundTripped).toEqual(piResult);
  });
});

// ---------------------------------------------------------------------------
// piMessagesToCore / coreMessagesToPi — batch conversion
// ---------------------------------------------------------------------------

describe("piMessagesToCore / coreMessagesToPi", () => {
  test("converts array of messages", () => {
    const piMsgs = [
      { role: "user" as const, content: "hi", timestamp: 1 },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "hello" }],
        api: "anthropic-messages" as const,
        provider: "anthropic",
        model: "test",
        usage: baseUsage,
        stopReason: "stop" as const,
        timestamp: 2,
      },
    ];
    const coreMsgs = piMessagesToCore(piMsgs);
    expect(coreMsgs).toHaveLength(2);
    expect(coreMsgs[0]!.role).toBe("user");
    expect(coreMsgs[1]!.role).toBe("assistant");
  });

  test("handles empty array", () => {
    expect(piMessagesToCore([])).toEqual([]);
    expect(coreMessagesToPi([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// piToolToCoreDef
// ---------------------------------------------------------------------------

describe("piToolToCoreDef", () => {
  test("maps tool name, description, parameters", () => {
    const piTool = {
      name: "my_tool",
      description: "Does things",
      parameters: { type: "object", properties: { x: { type: "string" } } },
    } as unknown as PiTool;
    const result = piToolToCoreDef(piTool);
    expect(result.name).toBe("my_tool");
    expect(result.description).toBe("Does things");
    expect(result.parameters).toEqual({ type: "object", properties: { x: { type: "string" } } });
  });
});

// ---------------------------------------------------------------------------
// Individual Core → Pi converters
// ---------------------------------------------------------------------------

describe("coreUserMessageToPi", () => {
  test("passes through structurally identical message", () => {
    const msg: CoreUserMessage = { role: "user", content: "test", timestamp: 100 };
    const result = coreUserMessageToPi(msg);
    expect(result.role).toBe("user");
    expect(result.content).toBe("test");
  });
});

describe("coreToolResultMessageToPi", () => {
  test("passes through structurally identical message", () => {
    const msg: CoreToolResultMessage = {
      role: "toolResult",
      toolCallId: "id1",
      toolName: "tool1",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 100,
    };
    const result = coreToolResultMessageToPi(msg);
    expect(result).toEqual(msg);
  });
});

describe("coreToolCallToPi", () => {
  test("passes through structurally identical tool call", () => {
    const tc = { type: "toolCall" as const, id: "x", name: "y", arguments: { a: 1 } };
    const result = coreToolCallToPi(tc);
    expect(result).toEqual(tc);
  });
});

describe("coreAssistantMessageToPi", () => {
  test("adds api field defaulting to unknown", () => {
    const msg: CoreAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      provider: "anthropic",
      model: "test",
      usage: baseUsage,
      stopReason: "stop",
      timestamp: 100,
    };
    const result = coreAssistantMessageToPi(msg);
    expect(result.api).toBe("unknown");
  });

  test("uses provided api value", () => {
    const msg: CoreAssistantMessage = {
      role: "assistant",
      content: [],
      provider: "openai",
      model: "gpt-4",
      usage: baseUsage,
      stopReason: "stop",
      timestamp: 200,
    };
    const result = coreAssistantMessageToPi(msg, "openai-completions");
    expect(result.api).toBe("openai-completions");
  });
});
