/**
 * Connector abstraction for interacting with the agent runtime.
 *
 * Connectors decouple test cases (and future CLI interfaces) from the
 * underlying transport.  A `DirectConnector` calls `handleRequest` in-process;
 * a Discord connector could go through the Discord message handler.
 */
import type { AppProgressEvent, AppRequest, AppResponse } from "../domain/assistant";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectorSendOptions {
  /** Conversation key — reuse across turns to maintain context. */
  conversationKey?: string;
  /** Called for each tool-use event the runtime emits during processing. */
  onToolUse?: (event: AppProgressEvent) => void | Promise<void>;
}

export interface ConnectorResult {
  response: AppResponse;
  /** Tool-use event strings captured during processing. */
  toolUseEvents: string[];
}

/**
 * A Connector knows how to send a text prompt into the agent runtime and
 * return the response plus any tool-use side-effects that happened along the
 * way.
 */
export interface Connector {
  readonly name: string;
  send(text: string, options?: ConnectorSendOptions): Promise<ConnectorResult>;
}

// ---------------------------------------------------------------------------
// DirectConnector — calls handleRequest in-process
// ---------------------------------------------------------------------------

interface DirectConnectorDeps {
  handleRequest: (
    request: AppRequest,
    options?: {
      onToolUse?: (event: AppProgressEvent) => Promise<void>;
    },
  ) => Promise<AppResponse>;
}

export class DirectConnector implements Connector {
  readonly name = "direct";
  private counter = 0;

  constructor(private readonly deps: DirectConnectorDeps) {}

  async send(text: string, options?: ConnectorSendOptions): Promise<ConnectorResult> {
    const toolUseEvents: string[] = [];
    const id = `e2e:cli:${Date.now()}-${++this.counter}`;
    const conversationKey = options?.conversationKey ?? id;

    const response = await this.deps.handleRequest(
      {
        id,
        kind: "chat",
        conversationKey,
        text,
      },
      {
        onToolUse: async (event) => {
          const eventStr = typeof event === "string" ? event : event.message;
          toolUseEvents.push(eventStr);
          await options?.onToolUse?.(event);
        },
      },
    );

    return { response, toolUseEvents };
  }
}
