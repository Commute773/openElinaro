import fs from "node:fs";
import path from "node:path";
import {
  normalizeClaudeHookEvent,
  normalizeCodexNotifyEvent,
  type ClaudeHookPayload,
  type CodexNotifyPayload,
  type SubagentEvent,
} from "./events";
import { telemetry } from "../services/telemetry";

type EventHandler = (event: SubagentEvent) => void | Promise<void>;

const sidecarTelemetry = telemetry.child({ component: "subagent_sidecar" });

/**
 * In-process HTTP sidecar that receives structured events from
 * Claude Code hooks and Codex notify scripts.
 *
 * Listens on a Unix domain socket so hook scripts can POST events
 * without needing a TCP port.
 */
export class SubagentSidecar {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly handlers: EventHandler[] = [];
  readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /** Register an event handler. Handlers may be async. */
  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  private async emit(event: SubagentEvent): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (error) {
        sidecarTelemetry.recordError(error, {
          operation: "sidecar.handler",
          runId: event.runId,
          eventKind: event.kind,
        });
      }
    }
  }

  start(): void {
    if (this.server) return;

    // Unix sockets have a max path length (~104 bytes on macOS).
    // If the configured path is too long, fall back to /tmp.
    const MAX_UNIX_SOCKET_PATH = 100;
    if (this.socketPath.length > MAX_UNIX_SOCKET_PATH) {
      const shortName = `openelinaro-sidecar-${process.pid}.sock`;
      (this as { socketPath: string }).socketPath = path.join("/tmp", shortName);
    }

    // Ensure the socket directory exists and remove stale socket
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    const self = this;
    this.server = Bun.serve({
      unix: this.socketPath,
      async fetch(req) {
        const url = new URL(req.url);
        const method = req.method;
        const pathname = url.pathname;

        if (method === "GET" && pathname === "/health") {
          return Response.json({ status: "ok" });
        }

        if (method === "POST" && pathname === "/events/claude") {
          try {
            const raw = (await req.json()) as ClaudeHookPayload;
            if (!raw.runId) {
              return new Response("Missing runId", { status: 400 });
            }
            const event = normalizeClaudeHookEvent(raw);
            sidecarTelemetry.event("sidecar.event_received", {
              provider: "claude",
              runId: event.runId,
              eventKind: event.kind,
            });
            await self.emit(event);
            return Response.json({ ok: true });
          } catch (error) {
            sidecarTelemetry.recordError(error, { operation: "sidecar.claude_route" });
            return new Response("Bad request", { status: 400 });
          }
        }

        if (method === "POST" && pathname === "/events/codex") {
          try {
            const raw = (await req.json()) as CodexNotifyPayload;
            if (!raw.runId) {
              return new Response("Missing runId", { status: 400 });
            }
            const event = normalizeCodexNotifyEvent(raw);
            sidecarTelemetry.event("sidecar.event_received", {
              provider: "codex",
              runId: event.runId,
              eventKind: event.kind,
            });
            await self.emit(event);
            return Response.json({ ok: true });
          } catch (error) {
            sidecarTelemetry.recordError(error, { operation: "sidecar.codex_route" });
            return new Response("Bad request", { status: 400 });
          }
        }

        return new Response("Not found", { status: 404 });
      },
    });

    fs.chmodSync(this.socketPath, 0o600);
    sidecarTelemetry.event("sidecar.started", { socketPath: this.socketPath });
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
      sidecarTelemetry.event("sidecar.stopped", { socketPath: this.socketPath });
    }
  }
}
