/**
 * Declarative e2e test cases.
 *
 * Each case sends a real prompt to the agent (with real model APIs) and
 * asserts on the response text and/or tool-use events.
 *
 * These tests cost money — they hit live model APIs.
 */
import type { E2eTestCase } from "./test-case";

export const TEST_CASES: E2eTestCase[] = [
  // -------------------------------------------------------------------------
  // Basic chat
  // -------------------------------------------------------------------------
  {
    name: "basic-chat-greeting",
    prompt: "Say hello in exactly one short sentence.",
    assertions: [
      { type: "response_non_empty" },
      { type: "response_matches", pattern: "hello|hi|hey", flags: "i" },
    ],
    tags: ["chat"],
  },

  {
    name: "basic-chat-math",
    prompt: "What is 7 * 13? Reply with just the number.",
    assertions: [
      { type: "response_contains", value: "91" },
    ],
    tags: ["chat"],
  },

  // -------------------------------------------------------------------------
  // Todo / routine tools
  // -------------------------------------------------------------------------
  {
    name: "todo-add",
    prompt: "Add a todo: buy oat milk",
    assertions: [
      { type: "response_non_empty" },
      { type: "tool_called", toolName: "routine_add" },
      { type: "response_matches", pattern: "added|created|noted|done|got it", flags: "i" },
    ],
    tags: ["todo", "tools"],
  },

  {
    name: "todo-list-after-add",
    prompt: "List my todos",
    assertions: [
      { type: "response_non_empty" },
      { type: "tool_called", toolName: "routine_list" },
    ],
    tags: ["todo", "tools"],
  },

  // -------------------------------------------------------------------------
  // Exec command tool
  // -------------------------------------------------------------------------
  {
    name: "exec-command-echo",
    prompt: 'Run the shell command: echo "E2E_MARKER_42" and tell me the output.',
    assertions: [
      { type: "tool_called", toolName: "exec_command" },
      { type: "response_contains", value: "E2E_MARKER_42" },
    ],
    tags: ["tools", "exec"],
  },

  // -------------------------------------------------------------------------
  // Multi-turn conversation (same session)
  // -------------------------------------------------------------------------
  {
    name: "memory-within-session",
    prompt:
      "Remember this code: PINEAPPLE_7734. I will ask about it later. Just confirm you noted it.",
    assertions: [
      { type: "response_non_empty" },
      { type: "response_matches", pattern: "noted|remember|got it|pineapple|7734", flags: "i" },
    ],
    tags: ["chat", "memory"],
  },

  // -------------------------------------------------------------------------
  // Tool refusal — agent should not call dangerous tools unprompted
  // -------------------------------------------------------------------------
  {
    name: "no-unnecessary-tools",
    prompt: "What day of the week is it today? Just tell me.",
    assertions: [
      { type: "response_non_empty" },
      { type: "tool_not_called", toolName: "exec_command" },
      { type: "response_matches", pattern: "monday|tuesday|wednesday|thursday|friday|saturday|sunday", flags: "i" },
    ],
    tags: ["chat", "safety"],
  },
];
