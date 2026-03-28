/**
 * Declarative test-case definitions for the e2e CLI test suite.
 *
 * Each test case describes a prompt to send and a set of assertions to verify
 * against the agent's response and tool-use events.
 */

// ---------------------------------------------------------------------------
// Assertion types
// ---------------------------------------------------------------------------

export interface ResponseContainsAssertion {
  type: "response_contains";
  /** Substring (case-insensitive) that must appear in the response. */
  value: string;
}

export interface ResponseNotContainsAssertion {
  type: "response_not_contains";
  /** Substring (case-insensitive) that must NOT appear in the response. */
  value: string;
}

export interface ResponseMatchesAssertion {
  type: "response_matches";
  /** Regex pattern to test against the response. */
  pattern: string;
  flags?: string;
}

export interface ToolCalledAssertion {
  type: "tool_called";
  /** Tool name (substring match against tool-use event strings). */
  toolName: string;
}

export interface ToolNotCalledAssertion {
  type: "tool_not_called";
  /** Tool name that should NOT appear in tool-use events. */
  toolName: string;
}

export interface ResponseNonEmptyAssertion {
  type: "response_non_empty";
}

export type TestAssertion =
  | ResponseContainsAssertion
  | ResponseNotContainsAssertion
  | ResponseMatchesAssertion
  | ToolCalledAssertion
  | ToolNotCalledAssertion
  | ResponseNonEmptyAssertion;

// ---------------------------------------------------------------------------
// Test case
// ---------------------------------------------------------------------------

export interface E2eTestCase {
  /** Human-readable name for reporting. */
  name: string;
  /** The prompt to send to the agent. */
  prompt: string;
  /** Assertions to check after receiving the response. */
  assertions: TestAssertion[];
  /** Optional timeout in ms (default 120_000). */
  timeoutMs?: number;
  /** Optional tags for filtering (e.g. "lights", "todo", "chat"). */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Assertion runner
// ---------------------------------------------------------------------------

export interface AssertionResult {
  assertion: TestAssertion;
  passed: boolean;
  detail: string;
}

export function runAssertions(
  responseMessage: string,
  toolUseEvents: string[],
  assertions: TestAssertion[],
): AssertionResult[] {
  return assertions.map((assertion) => {
    switch (assertion.type) {
      case "response_contains": {
        const lower = responseMessage.toLowerCase();
        const passed = lower.includes(assertion.value.toLowerCase());
        return {
          assertion,
          passed,
          detail: passed
            ? `Response contains "${assertion.value}"`
            : `Expected response to contain "${assertion.value}". Got: ${responseMessage.slice(0, 200)}`,
        };
      }

      case "response_not_contains": {
        const lower = responseMessage.toLowerCase();
        const passed = !lower.includes(assertion.value.toLowerCase());
        return {
          assertion,
          passed,
          detail: passed
            ? `Response does not contain "${assertion.value}"`
            : `Expected response NOT to contain "${assertion.value}"`,
        };
      }

      case "response_matches": {
        const regex = new RegExp(assertion.pattern, assertion.flags ?? "i");
        const passed = regex.test(responseMessage);
        return {
          assertion,
          passed,
          detail: passed
            ? `Response matches /${assertion.pattern}/`
            : `Expected response to match /${assertion.pattern}/. Got: ${responseMessage.slice(0, 200)}`,
        };
      }

      case "tool_called": {
        const passed = toolUseEvents.some((e) =>
          e.toLowerCase().includes(assertion.toolName.toLowerCase()),
        );
        return {
          assertion,
          passed,
          detail: passed
            ? `Tool "${assertion.toolName}" was called`
            : `Expected tool "${assertion.toolName}" to be called. Events: [${toolUseEvents.join(", ")}]`,
        };
      }

      case "tool_not_called": {
        const passed = !toolUseEvents.some((e) =>
          e.toLowerCase().includes(assertion.toolName.toLowerCase()),
        );
        return {
          assertion,
          passed,
          detail: passed
            ? `Tool "${assertion.toolName}" was not called`
            : `Expected tool "${assertion.toolName}" NOT to be called`,
        };
      }

      case "response_non_empty": {
        const passed = responseMessage.trim().length > 0;
        return {
          assertion,
          passed,
          detail: passed
            ? "Response is non-empty"
            : "Expected a non-empty response",
        };
      }
    }
  });
}
