import fs from "node:fs";
import path from "node:path";
import { resolveUserDataPath } from "./runtime-root";

export const DEFAULT_SERVICE_RESTART_CONTINUATION_MESSAGE =
  "System restarted. Continue what you were doing. This system restart may be unrelated to your actions.";

export interface PendingServiceRestartNotice {
  message: string;
  requestedAt: string;
  source?: string;
}

type StoredServiceRestartNotice = PendingServiceRestartNotice;

function timestamp() {
  return new Date().toISOString();
}

export class ServiceRestartNoticeService {
  constructor(
    private readonly storePath = resolveUserDataPath("service-restart-notice.json"),
  ) {}

  recordPendingNotice(params?: { message?: string; source?: string }) {
    const notice: StoredServiceRestartNotice = {
      message: params?.message?.trim() || DEFAULT_SERVICE_RESTART_CONTINUATION_MESSAGE,
      requestedAt: timestamp(),
      source: params?.source?.trim() || undefined,
    };
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, `${JSON.stringify(notice, null, 2)}\n`, { mode: 0o600 });
    return notice;
  }

  clearPendingNotice() {
    if (!fs.existsSync(this.storePath)) {
      return;
    }
    fs.rmSync(this.storePath, { force: true });
  }

  consumePendingNotice(): PendingServiceRestartNotice | undefined {
    if (!fs.existsSync(this.storePath)) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath, "utf8")) as Partial<StoredServiceRestartNotice>;
      if (!parsed.message || typeof parsed.message !== "string") {
        this.clearPendingNotice();
        return undefined;
      }
      const notice: PendingServiceRestartNotice = {
        message: parsed.message.trim(),
        requestedAt: typeof parsed.requestedAt === "string" && parsed.requestedAt.trim()
          ? parsed.requestedAt
          : timestamp(),
        source: typeof parsed.source === "string" && parsed.source.trim() ? parsed.source : undefined,
      };
      this.clearPendingNotice();
      return notice;
    } catch {
      this.clearPendingNotice();
      return undefined;
    }
  }
}
