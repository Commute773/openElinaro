import fs from "node:fs";
import path from "node:path";
import type { InstanceMessage, InstanceMessageResponse, InstanceStatus } from "./types";

export interface InstanceSocketServerOptions {
  socketPath: string;
  profileId: string;
  onMessage: (message: InstanceMessage) => Promise<InstanceMessageResponse>;
  onStatus: () => InstanceStatus;
}

/**
 * Unix socket HTTP server for receiving inter-instance messages.
 * Exposes two endpoints:
 *   POST /message — deliver a message to this instance
 *   GET  /status  — check instance status
 */
export class InstanceSocketServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(private readonly options: InstanceSocketServerOptions) {}

  start(): void {
    const { socketPath } = this.options;
    const socketDir = path.dirname(socketPath);
    fs.mkdirSync(socketDir, { recursive: true });

    // Remove stale socket file from a previous run
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    const self = this;
    this.server = Bun.serve({
      unix: socketPath,
      async fetch(req) {
        const url = new URL(req.url);

        if (req.method === "GET" && url.pathname === "/status") {
          return Response.json(self.options.onStatus());
        }

        if (req.method === "POST" && url.pathname === "/message") {
          try {
            const message = (await req.json()) as InstanceMessage;
            if (!message.from || !message.content || !message.conversationKey) {
              return Response.json(
                { accepted: false, conversationKey: "", error: "Missing required fields: from, content, conversationKey" },
                { status: 400 },
              );
            }
            const result = await self.options.onMessage(message);
            return Response.json(result, { status: result.accepted ? 200 : 400 });
          } catch {
            return Response.json(
              { accepted: false, conversationKey: "", error: "Invalid request body" },
              { status: 400 },
            );
          }
        }

        return Response.json({ error: "Not found" }, { status: 404 });
      },
    });

    fs.chmodSync(socketPath, 0o660);
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
  }

  get socketPath(): string {
    return this.options.socketPath;
  }
}
