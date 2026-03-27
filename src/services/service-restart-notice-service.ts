import { mkdir, chmod, rm } from "node:fs/promises";
import path from "node:path";
import { resolveUserDataPath } from "./runtime-root";
import { timestamp } from "../utils/timestamp";

export const DEFAULT_SERVICE_RESTART_CONTINUATION_MESSAGE =
  "System restarted. Continue what you were doing. This system restart may be unrelated to your actions.";

export interface PendingServiceRestartNotice {
  message: string;
  requestedAt: string;
  source?: string;
}

type StoredServiceRestartNotice = PendingServiceRestartNotice;

export class ServiceRestartNoticeService {
  constructor(
    private readonly storePath = resolveUserDataPath("service-restart-notice.json"),
  ) {}

  async recordPendingNotice(params?: { message?: string; source?: string }) {
    const notice: StoredServiceRestartNotice = {
      message: params?.message?.trim() || DEFAULT_SERVICE_RESTART_CONTINUATION_MESSAGE,
      requestedAt: timestamp(),
      source: params?.source?.trim() || undefined,
    };
    await mkdir(path.dirname(this.storePath), { recursive: true });
    await Bun.write(this.storePath, `${JSON.stringify(notice, null, 2)}\n`);
    await chmod(this.storePath, 0o600);
    return notice;
  }

  async clearPendingNotice() {
    if (!(await Bun.file(this.storePath).exists())) {
      return;
    }
    await rm(this.storePath, { force: true });
  }

  async consumePendingNotice(): Promise<PendingServiceRestartNotice | undefined> {
    if (!(await Bun.file(this.storePath).exists())) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(await Bun.file(this.storePath).text()) as Partial<StoredServiceRestartNotice>;
      if (!parsed.message || typeof parsed.message !== "string") {
        await this.clearPendingNotice();
        return undefined;
      }
      const notice: PendingServiceRestartNotice = {
        message: parsed.message.trim(),
        requestedAt: typeof parsed.requestedAt === "string" && parsed.requestedAt.trim()
          ? parsed.requestedAt
          : timestamp(),
        source: typeof parsed.source === "string" && parsed.source.trim() ? parsed.source : undefined,
      };
      await this.clearPendingNotice();
      return notice;
    } catch {
      await this.clearPendingNotice();
      return undefined;
    }
  }
}
