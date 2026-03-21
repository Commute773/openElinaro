import { ImapFlow, type FetchMessageObject, type MessageAddressObject } from "imapflow";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import PostalMime, { type Address as PostalAddress, type Email as ParsedEmail } from "postal-mime";
import { getRuntimeConfig } from "../config/runtime-config";
import { SecretStoreService } from "./secret-store-service";
import { telemetry } from "./telemetry";

const DEFAULT_EMAIL_PROVIDER = "IMAP/SMTP";
const DEFAULT_EMAIL_USERNAME = "";
const DEFAULT_EMAIL_IMAP_HOST = "";
const DEFAULT_EMAIL_IMAP_PORT = 993;
const DEFAULT_EMAIL_IMAP_SECURE = true;
const DEFAULT_EMAIL_IMAP_MAILBOX = "INBOX";
const DEFAULT_EMAIL_SMTP_HOST = "";
const DEFAULT_EMAIL_SMTP_PORT = 465;
const DEFAULT_EMAIL_SMTP_SECURE = true;
const DEFAULT_EMAIL_API_BASE_URL = "";
const DEFAULT_EMAIL_PASSWORD_SECRET_REF = "email.password";
const DEFAULT_EMAIL_API_KEY_SECRET_REF = "email.apiKey";
const DEFAULT_EMAIL_TIMEOUT_MS = 20_000;
const DEFAULT_EMAIL_LIST_LIMIT = 10;
const DEFAULT_EMAIL_MAX_BODY_CHARS = 12_000;

const emailTelemetry = telemetry.child({ component: "email" });

export type EmailAction =
  | "status"
  | "count"
  | "list_unread"
  | "list_recent"
  | "read"
  | "mark_read"
  | "mark_all_read"
  | "send";

export type EmailMailbox = "unread" | "recent";
export type EmailResponseFormat = "text" | "json";

type EmailHeaderMap = {
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  replyTo: string | null;
  messageId: string | null;
};

type EmailSummary = {
  index: number;
  uid: number;
  state: "unread" | "read";
  headers: EmailHeaderMap;
};

type EmailRead = EmailSummary & {
  mailbox: EmailMailbox;
  body: string;
  bodyTruncated: boolean;
};

type EmailSendResult = {
  ok: true;
  action: "send";
  messageId: string | null;
  accepted: string[];
  rejected: string[];
  response: string | null;
};

type EmailResponse =
  | {
      ok: true;
      action: "count";
      unreadCount: number;
    }
  | {
      ok: true;
      action: "list_unread" | "list_recent";
      mailbox: EmailMailbox;
      total: number;
      messages: EmailSummary[];
    }
  | {
      ok: true;
      action: "read";
      message: EmailRead;
    }
  | {
      ok: true;
      action: "mark_read";
      marked: {
        index: number;
        uid: number;
      };
      unreadCount: number;
    }
  | {
      ok: true;
      action: "mark_all_read";
      markedCount: number;
      unreadCount: number;
    }
  | EmailSendResult;

type EmailServiceConfig = {
  provider: string;
  username: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapMailbox: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  apiBaseUrl: string;
  passwordSecretRef: string;
  apiKeySecretRef: string;
  timeoutMs: number;
  maxBodyChars: number;
  listLimit: number;
};

type EmailInvokeParams = {
  action: EmailAction;
  mailbox?: EmailMailbox;
  index?: number;
  limit?: number;
  format?: EmailResponseFormat;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject?: string;
  body?: string;
};

type EmailServiceDependencies = {
  backend: EmailBackend;
};

type EmailStatusSummary = {
  unreadCount: number;
  apiAvailable: boolean;
};

type EmailSendParams = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  body: string;
};

interface EmailBackend {
  getStatusSummary(): Promise<EmailStatusSummary>;
  countUnread(): Promise<number>;
  listMailbox(mailbox: EmailMailbox, limit: number): Promise<Extract<EmailResponse, { action: "list_unread" | "list_recent" }>>;
  readMessage(mailbox: EmailMailbox, index: number, maxBodyChars: number): Promise<Extract<EmailResponse, { action: "read" }>>;
  markRead(index: number): Promise<Extract<EmailResponse, { action: "mark_read" }>>;
  markAllRead(): Promise<Extract<EmailResponse, { action: "mark_all_read" }>>;
  sendMessage(params: EmailSendParams): Promise<EmailSendResult>;
}

function traceSpan<T>(
  operation: string,
  fn: () => Promise<T>,
  options?: { attributes?: Record<string, unknown> },
) {
  return emailTelemetry.span(operation, options?.attributes ?? {}, fn);
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (!value?.trim()) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeHeaderValue(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : "(none)";
}

function formatMailboxLabel(mailbox: EmailMailbox) {
  return mailbox === "recent" ? "recent" : "unread";
}

function formatSecurityLabel(secure: boolean) {
  return secure ? "SSL/TLS" : "STARTTLS";
}

function normalizeMultilineText(value: string | undefined | null) {
  const normalized = value?.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return normalized ? normalized : null;
}

function htmlToText(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function asIsoOrString(value: Date | string | undefined | null) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const trimmed = String(value).trim();
  return trimmed || null;
}

function formatImapAddresses(addresses: MessageAddressObject[] | undefined) {
  if (!addresses?.length) {
    return null;
  }
  const formatted = addresses
    .map((address) => {
      const email = address.address?.trim();
      const name = address.name?.trim();
      if (name && email) {
        return `${name} <${email}>`;
      }
      return email ?? name ?? "";
    })
    .filter((value) => value.length > 0);
  return formatted.length > 0 ? formatted.join(", ") : null;
}

function formatPostalAddress(address: PostalAddress | undefined) {
  if (!address) {
    return null;
  }
  if ("group" in address && Array.isArray(address.group)) {
    const groupEntries = address.group
      .map((entry) => {
        const email = entry.address?.trim();
        const name = entry.name?.trim();
        if (name && email) {
          return `${name} <${email}>`;
        }
        return email ?? name ?? "";
      })
      .filter((value) => value.length > 0);
    if (groupEntries.length === 0) {
      return address.name?.trim() || null;
    }
    return `${address.name?.trim() || "Group"}: ${groupEntries.join(", ")}`;
  }
  const email = address.address?.trim();
  const name = address.name?.trim();
  if (name && email) {
    return `${name} <${email}>`;
  }
  return email ?? name ?? null;
}

function formatPostalAddresses(addresses: PostalAddress[] | undefined) {
  if (!addresses?.length) {
    return null;
  }
  const formatted = addresses
    .map((entry) => formatPostalAddress(entry))
    .filter((value): value is string => Boolean(value?.trim()));
  return formatted.length > 0 ? formatted.join(", ") : null;
}

function formatAcceptedAddress(value: string | { address?: string; name?: string }) {
  if (typeof value === "string") {
    return value;
  }
  const address = value.address?.trim();
  const name = value.name?.trim();
  if (name && address) {
    return `${name} <${address}>`;
  }
  return address ?? name ?? "";
}

function flagsToState(flags: Set<string> | undefined) {
  return flags?.has("\\Seen") ? "read" : "unread";
}

function buildSummaryHeaders(message: FetchMessageObject) {
  return {
    from: formatImapAddresses(message.envelope?.from),
    to: formatImapAddresses(message.envelope?.to),
    cc: formatImapAddresses(message.envelope?.cc),
    subject: normalizeMultilineText(message.envelope?.subject ?? null),
    date: asIsoOrString(message.envelope?.date ?? message.internalDate ?? null),
    replyTo: formatImapAddresses(message.envelope?.replyTo),
    messageId: normalizeMultilineText(message.envelope?.messageId ?? null),
  } satisfies EmailHeaderMap;
}

function buildReadHeaders(message: FetchMessageObject, parsed: ParsedEmail) {
  return {
    from: formatPostalAddress(parsed.from) ?? formatImapAddresses(message.envelope?.from),
    to: formatPostalAddresses(parsed.to) ?? formatImapAddresses(message.envelope?.to),
    cc: formatPostalAddresses(parsed.cc) ?? formatImapAddresses(message.envelope?.cc),
    subject: normalizeMultilineText(parsed.subject) ?? normalizeMultilineText(message.envelope?.subject ?? null),
    date: normalizeMultilineText(parsed.date) ?? asIsoOrString(message.envelope?.date ?? message.internalDate ?? null),
    replyTo: formatPostalAddresses(parsed.replyTo) ?? formatImapAddresses(message.envelope?.replyTo),
    messageId: normalizeMultilineText(parsed.messageId) ?? normalizeMultilineText(message.envelope?.messageId ?? null),
  } satisfies EmailHeaderMap;
}

function buildSummary(index: number, message: FetchMessageObject): EmailSummary {
  return {
    index,
    uid: message.uid,
    state: flagsToState(message.flags),
    headers: buildSummaryHeaders(message),
  };
}

function extractTextBody(email: ParsedEmail) {
  const text = normalizeMultilineText(email.text);
  if (text) {
    return text;
  }
  const html = normalizeMultilineText(email.html);
  return html ? htmlToText(html) : "";
}

function truncateBody(body: string, maxBodyChars: number) {
  if (maxBodyChars > 0 && body.length > maxBodyChars) {
    return {
      body: body.slice(0, maxBodyChars),
      bodyTruncated: true,
    };
  }
  return {
    body,
    bodyTruncated: false,
  };
}

function renderSummaryLine(message: EmailSummary) {
  return [
    `${String(message.index).padStart(2, " ")}.`,
    message.state === "unread" ? "[new]" : "[read]",
    `${normalizeHeaderValue(message.headers.from)}`,
    `| ${normalizeHeaderValue(message.headers.subject)}`,
    `| ${normalizeHeaderValue(message.headers.date)}`,
  ].join(" ");
}

function renderReadMessage(message: EmailRead) {
  return [
    `Mailbox: ${formatMailboxLabel(message.mailbox)}`,
    `Index: ${message.index}`,
    `Uid: ${message.uid}`,
    `State: ${message.state}`,
    `From: ${normalizeHeaderValue(message.headers.from)}`,
    `To: ${normalizeHeaderValue(message.headers.to)}`,
    `Cc: ${normalizeHeaderValue(message.headers.cc)}`,
    `Reply-To: ${normalizeHeaderValue(message.headers.replyTo)}`,
    `Subject: ${normalizeHeaderValue(message.headers.subject)}`,
    `Date: ${normalizeHeaderValue(message.headers.date)}`,
    `Message-Id: ${normalizeHeaderValue(message.headers.messageId)}`,
    "",
    "Body:",
    message.body || "(empty)",
    message.bodyTruncated ? "[body truncated]" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatAccountLabel(value: string) {
  const normalized = value.trim();
  return normalized || "(unset)";
}

function resolveConfig(): EmailServiceConfig {
  const configured = getRuntimeConfig().email;
  return {
    provider: configured.provider || DEFAULT_EMAIL_PROVIDER,
    username: configured.username || DEFAULT_EMAIL_USERNAME,
    imapHost: configured.imapHost || DEFAULT_EMAIL_IMAP_HOST,
    imapPort: parsePositiveInt(String(configured.imapPort), DEFAULT_EMAIL_IMAP_PORT),
    imapSecure: configured.imapSecure ?? DEFAULT_EMAIL_IMAP_SECURE,
    imapMailbox: configured.imapMailbox || DEFAULT_EMAIL_IMAP_MAILBOX,
    smtpHost: configured.smtpHost || DEFAULT_EMAIL_SMTP_HOST,
    smtpPort: parsePositiveInt(String(configured.smtpPort), DEFAULT_EMAIL_SMTP_PORT),
    smtpSecure: configured.smtpSecure ?? DEFAULT_EMAIL_SMTP_SECURE,
    apiBaseUrl: configured.apiBaseUrl || DEFAULT_EMAIL_API_BASE_URL,
    passwordSecretRef: configured.passwordSecretRef || DEFAULT_EMAIL_PASSWORD_SECRET_REF,
    apiKeySecretRef: configured.apiKeySecretRef || DEFAULT_EMAIL_API_KEY_SECRET_REF,
    timeoutMs: parsePositiveInt(String(configured.timeoutMs), DEFAULT_EMAIL_TIMEOUT_MS),
    maxBodyChars: parsePositiveInt(String(configured.maxBodyChars), DEFAULT_EMAIL_MAX_BODY_CHARS),
    listLimit: parsePositiveInt(String(configured.listLimit), DEFAULT_EMAIL_LIST_LIMIT),
  };
}

class PurelymailEmailBackend implements EmailBackend {
  constructor(
    private readonly config: EmailServiceConfig,
    private readonly secrets: SecretStoreService,
    private readonly createTransport: typeof nodemailer.createTransport = nodemailer.createTransport,
  ) {}

  async getStatusSummary(): Promise<EmailStatusSummary> {
    const [unreadCount, apiKey] = await Promise.all([
      this.countUnread(),
      Promise.resolve(this.resolveApiKey()),
    ]);
    return {
      unreadCount,
      apiAvailable: apiKey.trim().length > 0,
    };
  }

  async countUnread() {
    return this.withImapClient("count_unread", async (client) => {
      const unread = await this.listMessageUids(client, "unread");
      return unread.length;
    });
  }

  async listMailbox(mailbox: EmailMailbox, limit: number) {
    return this.withImapClient(`list_${mailbox}`, async (client) => {
      const uids = await this.listMessageUids(client, mailbox);
      const selected = uids.slice(0, Math.max(1, Math.min(limit, 50)));
      const fetched = await this.fetchMessages(client, selected, {
        envelope: true,
        flags: true,
        internalDate: true,
      });

      return {
        ok: true,
        action: mailbox === "recent" ? "list_recent" : "list_unread",
        mailbox,
        total: uids.length,
        messages: selected
          .map((uid, index) => {
            const message = fetched.get(uid);
            return message ? buildSummary(index + 1, message) : null;
          })
          .filter((value): value is EmailSummary => value !== null),
      } satisfies Extract<EmailResponse, { action: "list_unread" | "list_recent" }>;
    });
  }

  async readMessage(mailbox: EmailMailbox, index: number, maxBodyChars: number) {
    return this.withImapClient(`read_${mailbox}`, async (client) => {
      const target = await this.resolveIndexedMessage(client, mailbox, index);
      const message = await client.fetchOne(
        target.uid,
        {
          envelope: true,
          flags: true,
          internalDate: true,
          source: true,
        },
        { uid: true },
      );
      if (!message || !message.source) {
        throw new Error(`Unable to fetch source for message #${index}.`);
      }

      const parsed = await PostalMime.parse(message.source);
      const bodyState = truncateBody(extractTextBody(parsed), maxBodyChars);

      return {
        ok: true,
        action: "read",
        message: {
          index,
          uid: message.uid,
          mailbox,
          state: flagsToState(message.flags),
          headers: buildReadHeaders(message, parsed),
          body: bodyState.body,
          bodyTruncated: bodyState.bodyTruncated,
        },
      } satisfies Extract<EmailResponse, { action: "read" }>;
    });
  }

  async markRead(index: number) {
    return this.withImapClient("mark_read", async (client) => {
      const target = await this.resolveIndexedMessage(client, "unread", index);
      await client.messageFlagsAdd(target.uid, ["\\Seen"], { uid: true });
      const unreadCount = (await this.listMessageUids(client, "unread")).length;
      return {
        ok: true,
        action: "mark_read",
        marked: {
          index,
          uid: target.uid,
        },
        unreadCount,
      } satisfies Extract<EmailResponse, { action: "mark_read" }>;
    });
  }

  async markAllRead() {
    return this.withImapClient("mark_all_read", async (client) => {
      const unread = await this.listMessageUids(client, "unread");
      if (unread.length > 0) {
        await client.messageFlagsAdd(unread, ["\\Seen"], { uid: true });
      }
      return {
        ok: true,
        action: "mark_all_read",
        markedCount: unread.length,
        unreadCount: 0,
      } satisfies Extract<EmailResponse, { action: "mark_all_read" }>;
    });
  }

  async sendMessage(params: EmailSendParams): Promise<EmailSendResult> {
    const transporter = this.createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: this.config.smtpSecure,
      auth: {
        user: this.config.username,
        pass: this.resolvePassword(),
      },
      connectionTimeout: this.config.timeoutMs,
      greetingTimeout: this.config.timeoutMs,
      socketTimeout: this.config.timeoutMs,
      tls: {
        minVersion: "TLSv1.2",
      },
    });

    try {
      const result = await transporter.sendMail({
        from: this.config.username,
        to: params.to,
        cc: params.cc,
        bcc: params.bcc,
        replyTo: params.replyTo,
        subject: params.subject,
        text: params.body,
      });

      return {
        ok: true,
        action: "send",
        messageId: typeof result.messageId === "string" ? result.messageId : null,
        accepted: Array.isArray(result.accepted) ? result.accepted.map(formatAcceptedAddress).filter(Boolean) : [],
        rejected: Array.isArray(result.rejected) ? result.rejected.map(formatAcceptedAddress).filter(Boolean) : [],
        response: typeof result.response === "string" ? result.response : null,
      };
    } finally {
      transporter.close();
    }
  }

  private resolvePassword() {
    return this.secrets.resolveSecretRef(this.config.passwordSecretRef);
  }

  private resolveApiKey() {
    return this.secrets.resolveSecretRef(this.config.apiKeySecretRef);
  }

  private async withImapClient<T>(operation: string, fn: (client: ImapFlow) => Promise<T>) {
    const client = new ImapFlow({
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: this.config.imapSecure,
      auth: {
        user: this.config.username,
        pass: this.resolvePassword(),
      },
      disableAutoIdle: true,
      logger: false,
      connectionTimeout: this.config.timeoutMs,
      greetingTimeout: this.config.timeoutMs,
      socketTimeout: this.config.timeoutMs,
      tls: {
        minVersion: "TLSv1.2",
      },
    });

    return traceSpan(`email.backend.${operation}`, async () => {
      await client.connect();
      const lock = await client.getMailboxLock(this.config.imapMailbox);
      try {
        return await fn(client);
      } finally {
        lock.release();
        if (client.usable) {
          await client.logout().catch(() => undefined);
        }
      }
    });
  }

  private async listMessageUids(client: ImapFlow, mailbox: EmailMailbox) {
    const result = await client.search(mailbox === "unread" ? { seen: false } : { all: true }, { uid: true });
    return (Array.isArray(result) ? result : []).sort((left, right) => right - left);
  }

  private async fetchMessages(
    client: ImapFlow,
    uids: number[],
    query: {
      envelope?: boolean;
      flags?: boolean;
      internalDate?: boolean;
    },
  ) {
    if (uids.length === 0) {
      return new Map<number, FetchMessageObject>();
    }
    const messages = await client.fetchAll(uids, query, { uid: true });
    return new Map(messages.map((message) => [message.uid, message]));
  }

  private async resolveIndexedMessage(client: ImapFlow, mailbox: EmailMailbox, index: number) {
    const uids = await this.listMessageUids(client, mailbox);
    if (index < 1 || index > uids.length) {
      throw new Error(`Message index ${index} is out of range for ${formatMailboxLabel(mailbox)} mail.`);
    }
    return {
      uid: uids[index - 1]!,
      total: uids.length,
    };
  }
}

export class EmailService {
  private readonly config: EmailServiceConfig;
  private readonly backend: EmailBackend;

  constructor(
    dependencies?: Partial<EmailServiceDependencies>,
    config?: Partial<EmailServiceConfig>,
  ) {
    this.config = {
      ...resolveConfig(),
      ...config,
    };
    this.backend = dependencies?.backend ?? new PurelymailEmailBackend(this.config, new SecretStoreService());
  }

  getConfig() {
    return { ...this.config };
  }

  async invoke(params: EmailInvokeParams) {
    return traceSpan(
      "email.invoke",
      async () => {
        const format = params.format ?? "text";
        switch (params.action) {
          case "status": {
            const summary = await this.backend.getStatusSummary();
            const payload = {
              provider: this.config.provider,
              account: this.config.username,
              unreadCount: summary.unreadCount,
              imap: {
                host: this.config.imapHost,
                port: this.config.imapPort,
                security: formatSecurityLabel(this.config.imapSecure),
                mailbox: this.config.imapMailbox,
              },
              smtp: {
                host: this.config.smtpHost,
                port: this.config.smtpPort,
                security: formatSecurityLabel(this.config.smtpSecure),
              },
              api: {
                baseUrl: this.config.apiBaseUrl,
                configured: summary.apiAvailable,
              },
              writeActions: ["mark_read", "mark_all_read", "send"],
            };
            return format === "json"
              ? JSON.stringify(payload, null, 2)
              : [
                  `Email source: ${payload.provider} ${formatAccountLabel(payload.account)}`,
                  `Unread messages: ${payload.unreadCount}`,
                  `IMAP: ${payload.imap.host}:${payload.imap.port} (${payload.imap.security}) mailbox=${payload.imap.mailbox}`,
                  `SMTP: ${payload.smtp.host}:${payload.smtp.port} (${payload.smtp.security})`,
                  `API: ${payload.api.baseUrl} (${payload.api.configured ? "configured" : "missing key"})`,
                  `Write actions: ${payload.writeActions.join(", ")}`,
                ].join("\n");
          }
          case "count": {
            const result = {
              ok: true,
              action: "count",
              unreadCount: await this.backend.countUnread(),
            } satisfies Extract<EmailResponse, { action: "count" }>;
            return format === "json" ? JSON.stringify(result, null, 2) : `Unread messages: ${result.unreadCount}`;
          }
          case "list_unread":
          case "list_recent": {
            const mailbox = params.action === "list_recent" ? "recent" : "unread";
            const result = await this.backend.listMailbox(mailbox, params.limit ?? this.config.listLimit);
            if (format === "json") {
              return JSON.stringify(result, null, 2);
            }
            return [
              `${result.total} ${formatMailboxLabel(result.mailbox)} messages total.`,
              result.messages.length > 0
                ? result.messages.map(renderSummaryLine).join("\n")
                : "No messages matched.",
            ].join("\n");
          }
          case "read": {
            const result = await this.backend.readMessage(
              params.mailbox ?? "unread",
              params.index ?? 0,
              this.config.maxBodyChars,
            );
            return format === "json" ? JSON.stringify(result, null, 2) : renderReadMessage(result.message);
          }
          case "mark_read": {
            const result = await this.backend.markRead(params.index ?? 0);
            return format === "json"
              ? JSON.stringify(result, null, 2)
              : [
                  `Marked unread message #${result.marked.index} as read.`,
                  `Uid: ${result.marked.uid}`,
                  `Unread remaining: ${result.unreadCount}`,
                ].join("\n");
          }
          case "mark_all_read": {
            const result = await this.backend.markAllRead();
            return format === "json"
              ? JSON.stringify(result, null, 2)
              : [
                  `Marked ${result.markedCount} unread messages as read.`,
                  `Unread remaining: ${result.unreadCount}`,
                ].join("\n");
          }
          case "send": {
            const to = params.to?.filter((value) => value.trim().length > 0) ?? [];
            if (to.length === 0) {
              throw new Error("send requires at least one recipient in to.");
            }
            const subject = params.subject?.trim();
            if (!subject) {
              throw new Error("send requires a subject.");
            }
            const body = params.body?.trim();
            if (!body) {
              throw new Error("send requires a body.");
            }
            const result = await this.backend.sendMessage({
              to,
              cc: params.cc?.filter((value) => value.trim().length > 0),
              bcc: params.bcc?.filter((value) => value.trim().length > 0),
              replyTo: params.replyTo?.filter((value) => value.trim().length > 0),
              subject,
              body,
            });
            return format === "json"
              ? JSON.stringify(result, null, 2)
              : [
                  `Sent email to ${result.accepted.length > 0 ? result.accepted.join(", ") : to.join(", ")}.`,
                  `Subject: ${subject}`,
                  `Message-Id: ${normalizeHeaderValue(result.messageId)}`,
                  `SMTP response: ${normalizeHeaderValue(result.response)}`,
                  result.rejected.length > 0 ? `Rejected: ${result.rejected.join(", ")}` : "",
                ]
                  .filter(Boolean)
                  .join("\n");
          }
          default:
            throw new Error(`Unsupported email action: ${String(params.action)}`);
        }
      },
      {
        attributes: {
          action: params.action,
          mailbox: params.mailbox,
          index: params.index,
          limit: params.limit,
          hasTo: Boolean(params.to?.length),
          hasCc: Boolean(params.cc?.length),
          hasBcc: Boolean(params.bcc?.length),
        },
      },
    );
  }
}
