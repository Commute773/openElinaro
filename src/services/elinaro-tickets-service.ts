import net from "node:net";
import { spawn } from "node:child_process";
import { getRuntimeConfig } from "../config/runtime-config";
import { SecretStoreService } from "./secret-store-service";
import { telemetry } from "./telemetry";

const ticketsTelemetry = telemetry.child({ component: "tickets" });

export const ELINARO_TICKET_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "review",
  "done",
  "wontfix",
] as const;

export const ELINARO_TICKET_PRIORITIES = ["critical", "high", "medium", "low"] as const;

export type ElinaroTicketStatus = (typeof ELINARO_TICKET_STATUSES)[number];
export type ElinaroTicketPriority = (typeof ELINARO_TICKET_PRIORITIES)[number];
export const ELINARO_DEFAULT_VISIBLE_TICKET_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "review",
] as const satisfies readonly ElinaroTicketStatus[];

export interface ElinaroTicket {
  seq: number;
  id: string;
  title: string;
  description: string;
  status: ElinaroTicketStatus;
  priority: ElinaroTicketPriority;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface ListElinaroTicketsParams {
  statuses?: ElinaroTicketStatus[];
  priority?: ElinaroTicketPriority;
  label?: string;
  query?: string;
  sort?: "created_at" | "updated_at" | "priority";
  order?: "asc" | "desc";
}

export interface CreateElinaroTicketInput {
  title: string;
  description?: string;
  status?: ElinaroTicketStatus;
  priority: ElinaroTicketPriority;
  labels?: string[];
}

export interface UpdateElinaroTicketInput {
  title?: string;
  description?: string;
  status?: ElinaroTicketStatus;
  priority?: ElinaroTicketPriority;
  labels?: string[];
}

interface TicketsEnvelope<T> {
  ok: boolean;
  data?: T;
  meta?: {
    total?: number;
    page?: number;
  };
  error?: {
    code?: string;
    message?: string;
  };
}

export class ElinaroTicketsService {
  private readonly apiUrl: string | undefined;
  private readonly token: string | undefined;
  private readonly sshTarget: string | undefined;
  private readonly sshRemotePort: number;
  private readonly secrets: SecretStoreService;

  constructor(options?: {
    apiUrl?: string;
    token?: string;
    sshTarget?: string;
    sshRemotePort?: number;
    secrets?: SecretStoreService;
  }) {
    const configured = getRuntimeConfig().tickets;
    this.secrets = options?.secrets ?? new SecretStoreService();
    this.apiUrl = options?.apiUrl?.trim() || configured.apiUrl.trim() || undefined;
    this.token = options?.token?.trim()
      || (configured.tokenSecretRef?.trim()
        ? this.secrets.resolveSecretRef(configured.tokenSecretRef.trim())
        : undefined);
    this.sshTarget = options?.sshTarget?.trim() || configured.sshTarget.trim() || undefined;
    this.sshRemotePort = options?.sshRemotePort ?? configured.remotePort ?? 3011;
  }

  isConfigured() {
    return Boolean(this.token && (this.apiUrl || this.sshTarget));
  }

  getConfigurationError() {
    if (!this.token) {
      return "Tickets API token secret is not configured.";
    }
    if (!this.apiUrl && !this.sshTarget) {
      return "Configure integrations.tickets.apiUrl or integrations.tickets.sshTarget.";
    }
    return null;
  }

  async listTickets(params: ListElinaroTicketsParams = {}) {
    const query = new URLSearchParams();
    if (params.statuses?.length) {
      query.set("status", params.statuses.join(","));
    }
    if (params.priority) {
      query.set("priority", params.priority);
    }
    if (params.label) {
      query.set("label", params.label);
    }
    if (params.query) {
      query.set("q", params.query);
    }
    if (params.sort) {
      query.set("sort", params.sort);
    }
    if (params.order) {
      query.set("order", params.order);
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const envelope = await this.request<TicketsEnvelope<ElinaroTicket[]>>("GET", `/api/tickets${suffix}`);
    return {
      tickets: envelope.data ?? [],
      total: envelope.meta?.total ?? envelope.data?.length ?? 0,
      page: envelope.meta?.page ?? 1,
    };
  }

  async getTicket(id: string) {
    const envelope = await this.request<TicketsEnvelope<ElinaroTicket>>("GET", `/api/tickets/${encodeURIComponent(id)}`);
    if (!envelope.data) {
      throw new Error(`Ticket ${id} was not returned by the API.`);
    }
    return envelope.data;
  }

  async createTicket(input: CreateElinaroTicketInput) {
    const envelope = await this.request<TicketsEnvelope<ElinaroTicket>>("POST", "/api/tickets", input);
    if (!envelope.data) {
      throw new Error("Ticket creation did not return a ticket.");
    }
    return envelope.data;
  }

  async updateTicket(id: string, input: UpdateElinaroTicketInput) {
    const envelope = await this.request<TicketsEnvelope<ElinaroTicket>>(
      "PATCH",
      `/api/tickets/${encodeURIComponent(id)}`,
      input,
    );
    if (!envelope.data) {
      throw new Error(`Ticket ${id} update did not return a ticket.`);
    }
    return envelope.data;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const configError = this.getConfigurationError();
    if (configError) {
      throw new Error(`Elinaro Tickets is unavailable: ${configError}`);
    }

    return this.withBaseUrl(async (baseUrl) => {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const payload = (await response.json().catch((error) => {
        ticketsTelemetry.event("tickets.response_parse_failed", {
          method,
          path,
          status: response.status,
          error: error instanceof Error ? error.message : String(error),
        }, { level: "warn", outcome: "error" });
        return null;
      })) as TicketsEnvelope<unknown> | null;
      if (!response.ok || !payload || payload.ok === false) {
        const message = payload?.error?.message?.trim() || `Ticket API request failed with ${response.status}.`;
        throw new Error(message);
      }

      return payload as T;
    });
  }

  private async withBaseUrl<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
    if (this.apiUrl) {
      return fn(this.apiUrl);
    }

    const tunnel = await openSshTunnel({
      target: this.sshTarget!,
      remotePort: this.sshRemotePort,
    });
    try {
      return await fn(`http://127.0.0.1:${tunnel.localPort}`);
    } finally {
      await tunnel.close();
    }
  }
}

async function openSshTunnel(params: { target: string; remotePort: number }) {
  const localPort = await getFreePort();
  const child = spawn(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${params.remotePort}`,
      "-N",
      params.target,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await waitForTunnel(localPort, child, () => stderr);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  return {
    localPort,
    close: async () => {
      if (child.exitCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 500);
      });
    },
  };
}

async function waitForTunnel(localPort: number, child: ReturnType<typeof spawn>, getStderr: () => string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (child.exitCode !== null) {
      const stderr = getStderr().trim();
      throw new Error(`Failed to open SSH tunnel for Elinaro Tickets.${stderr ? ` ${stderr}` : ""}`);
    }

    if (await isPortOpen(localPort)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  child.kill("SIGTERM");
  throw new Error("Timed out opening SSH tunnel for Elinaro Tickets.");
}

async function isPortOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate local port.")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
