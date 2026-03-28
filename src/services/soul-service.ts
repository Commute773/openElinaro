import type { ProfileRecord } from "../domain/profiles";
import { MemoryService } from "./memory-service";
import { ModelService } from "./models/model-service";
import { ReflectionPromptService } from "./reflection-prompt-service";
import { ReflectionStateService } from "./reflection-state-service";
import type { RoutinesService } from "./routines-service";
import { telemetry } from "./infrastructure/telemetry";
import { createTraceSpan } from "../utils/telemetry-helpers";
import { nowInTimezone, localDateKey } from "../utils/time-helpers";

const SOUL_REWRITE_INTERVAL_DAYS = 7;
const MAX_RECENT_JOURNAL_CHARS = 12_000;
const soulTelemetry = telemetry.child({ component: "soul" });

const traceSpan = createTraceSpan(soulTelemetry);

function compactTail(text: string, maxChars: number) {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(Math.max(0, normalized.length - maxChars)).trimStart();
}

function localDateDistanceInDays(fromDate: string | undefined, toDate: string) {
  if (!fromDate) {
    return Number.POSITIVE_INFINITY;
  }
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor((to - from) / 86_400_000);
}

export class SoulService {
  private queuedJob: Promise<void> = Promise.resolve();
  private readonly prompts = new ReflectionPromptService();
  private readonly state = new ReflectionStateService();

  constructor(
    private readonly profile: ProfileRecord,
    private readonly routines: RoutinesService,
    private readonly memory: MemoryService,
    private readonly models: Pick<ModelService, "generateMemoryText">,
  ) {}

  isScheduledRewriteEligible(reference: Date = new Date()) {
    const prompt = this.prompts.loadSoulRewritePrompt();
    if (!prompt) {
      return false;
    }

    const timezone = this.routines.loadData().settings.timezone;
    const localNow = nowInTimezone(timezone, reference);
    const localDate = localDateKey(localNow);
    const state = this.state.getProfileState(this.profile);
    return localDateDistanceInDays(state.lastSoulRewriteLocalDate, localDate) >= SOUL_REWRITE_INTERVAL_DAYS;
  }

  queueScheduledRewriteIfEligible(reference: Date = new Date()) {
    if (!this.isScheduledRewriteEligible(reference)) {
      return;
    }
    this.enqueue(async () => {
      if (!this.isScheduledRewriteEligible(reference)) {
        return;
      }
      await this.runRewrite({
        trigger: "scheduled",
        reference,
      });
    });
  }

  async runExplicitRewrite(params?: { focus?: string; reference?: Date }) {
    return this.runRewrite({
      trigger: "explicit",
      reference: params?.reference ?? new Date(),
      focus: params?.focus,
    });
  }

  private enqueue(job: () => Promise<void>) {
    this.queuedJob = this.queuedJob
      .catch(() => undefined)
      .then(job)
      .catch((error) => {
        soulTelemetry.recordError(error, {
          profileId: this.profile.id,
          operation: "soul.queue",
        });
      });
  }

  private async runRewrite(params: {
    trigger: "scheduled" | "explicit";
    reference: Date;
    focus?: string;
  }) {
    return traceSpan(
      "soul.rewrite",
      async () => {
        const prompt = this.prompts.loadSoulRewritePrompt();
        if (!prompt) {
          return null;
        }

        const timezone = this.routines.loadData().settings.timezone;
        const localNow = nowInTimezone(timezone, params.reference);
        const localDate = localDateKey(localNow);
        const currentSoul = await this.memory.readProfileDocument("identity/SOUL.md");
        const journal = await this.memory.readProfileDocument("identity/JOURNAL.md");
        const responseText = await this.models.generateMemoryText({
          systemPrompt: prompt.soulRewrite.text,
          userPrompt: [
            `Trigger: ${params.trigger}`,
            `Occurred at: ${params.reference.toISOString()}`,
            `Local date: ${localDate}`,
            params.focus?.trim() ? `Focus: ${params.focus.trim()}` : "",
            "",
            "Current SOUL.md:",
            currentSoul?.trim() || "(none)",
            "",
            "Recent journal entries:",
            journal?.trim() ? compactTail(journal, MAX_RECENT_JOURNAL_CHARS) : "(none)",
          ].filter(Boolean).join("\n"),
          usagePurpose: `soul_${params.trigger}`,
          sessionIdPrefix: `soul-${params.trigger}`,
        });

        const content = responseText.trim();
        if (!content) {
          return null;
        }

        const filePath = await this.memory.upsertProfileDocument({
          relativePath: "identity/SOUL.md",
          content: `${content}\n`,
        });
        this.state.updateProfileState(this.profile, (current) => ({
          ...current,
          lastSoulRewriteLocalDate: localDate,
        }));
        return {
          filePath,
          content,
          trigger: params.trigger,
          localDate,
        };
      },
      {
        attributes: {
          profileId: this.profile.id,
          trigger: params.trigger,
        },
      },
    );
  }
}
