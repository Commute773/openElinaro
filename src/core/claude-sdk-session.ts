/**
 * Persistent wrapper around the Claude Agent SDK's v1 Query object.
 *
 * Uses streaming input mode (`prompt: AsyncIterable<SDKUserMessage>`)
 * to keep a single Query (and its underlying subprocess) alive across
 * multiple conversational turns. Each `sendMessage()` pushes a new user
 * message into the channel; the caller reads responses via `nextMessage()`
 * using the raw iterator protocol (avoids for-await which would close
 * the generator on break).
 */
import {
  query as sdkQuery,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncChannel } from "./async-channel";
import { attempt } from "../utils/result";

/**
 * Shape of the SDK's internal ProcessTransport, accessed via (query as any).transport.
 * We only read from it — never write — so breakage would just disable the proactive check.
 */
interface ProcessTransportLike {
  isReady?: () => boolean;
  onExit?: (callback: (error?: Error) => void) => () => void;
}

export class ClaudeSdkSession {
  private readonly channel: AsyncChannel<SDKUserMessage>;
  private readonly queryInstance: Query;
  private readonly iterator: AsyncIterator<SDKMessage>;
  private _sessionId: string | undefined;
  private _alive = true;
  private _removeExitListener?: () => void;

  private constructor(channel: AsyncChannel<SDKUserMessage>, queryInstance: Query) {
    this.channel = channel;
    this.queryInstance = queryInstance;
    this.iterator = queryInstance[Symbol.asyncIterator]();

    // Proactively detect subprocess death so isAlive reflects reality
    // even before the next nextMessage() call.
    this.attachExitListener();
  }

  /**
   * Create a new persistent session with the given SDK options.
   * The session starts idle — call `sendMessage()` to trigger the first turn.
   */
  static create(options: Options): ClaudeSdkSession {
    const channel = new AsyncChannel<SDKUserMessage>();

    // Omit `prompt` from options — we provide the channel as the streaming input
    const { ...rest } = options;
    const queryInstance = sdkQuery({ prompt: channel, options: rest });

    return new ClaudeSdkSession(channel, queryInstance);
  }

  /** Push a user message to start or continue a turn. */
  sendMessage(text: string, priority?: SDKUserMessage["priority"]): void {
    if (!this._alive) throw new Error("Session is closed");
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString(),
      ...(priority ? { priority } : {}),
    };
    this.channel.push(msg);
  }

  /**
   * Inject a steering message into the active session with immediate priority.
   * The SDK will interrupt the current agent loop to process this message.
   */
  steer(text: string): void {
    if (!this._alive) throw new Error("Session is closed");
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString(),
      priority: "now",
    };
    this.channel.push(msg);
  }

  /**
   * Read the next message from the query stream.
   * Uses the raw iterator protocol so the generator stays alive between turns.
   * Returns `{ done: true }` when the query subprocess exits.
   */
  async nextMessage(): Promise<IteratorResult<SDKMessage>> {
    if (!this._alive) return { value: undefined as any, done: true };
    const result = await this.iterator.next();
    if (result.done) {
      this._alive = false;
    }
    return result;
  }

  /** Close the session and its underlying subprocess. */
  close(): void {
    if (!this._alive) return;
    this._alive = false;
    this._removeExitListener?.();
    this._removeExitListener = undefined;
    this.channel.close();
    this.queryInstance.close();
  }

  /** Interrupt the current agent execution without closing the session. */
  async interrupt(): Promise<void> {
    if (!this._alive) return;
    await this.queryInstance.interrupt();
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  /** Called by the core when a system init message provides the session ID. */
  setSessionId(id: string): void {
    this._sessionId = id;
  }

  get isAlive(): boolean {
    if (!this._alive) return false;
    // Double-check via transport readiness — the exit listener may have missed
    // the subprocess death if SDK internals changed shape.
    if (!this.checkTransportReady()) {
      this._alive = false;
      return false;
    }
    return true;
  }

  /**
   * Best-effort check of whether the SDK transport is still ready.
   * Falls back to true if the SDK internals are inaccessible.
   */
  private checkTransportReady(): boolean {
    try {
      const transport = (this.queryInstance as any)?.transport as ProcessTransportLike | undefined;
      if (typeof transport?.isReady === "function") {
        return transport.isReady();
      }
    } catch {
      // SDK internals inaccessible — assume alive, reactive detection is the fallback
    }
    return true;
  }

  /** Access the underlying Query for advanced control (setMcpServers, etc.). */
  get query(): Query {
    return this.queryInstance;
  }

  // ---------------------------------------------------------------------------
  // Proactive subprocess death detection
  // ---------------------------------------------------------------------------

  /**
   * Hook into the SDK's internal ProcessTransport.onExit() so we learn about
   * subprocess death immediately — not just on the next nextMessage() call.
   * This is best-effort: if the SDK internals change shape, the attach silently
   * fails and we fall back to the reactive detection in nextMessage().
   */
  private attachExitListener(): void {
    const result = attempt(() => {
      const transport = (this.queryInstance as any)?.transport as ProcessTransportLike | undefined;
      if (typeof transport?.onExit === "function") {
        this._removeExitListener = transport.onExit(() => {
          this._alive = false;
        });
      }
    });
    // SDK internals changed — no-op, reactive detection is the fallback.
    void result;
  }
}
