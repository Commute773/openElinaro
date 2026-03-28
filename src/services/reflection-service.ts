import type { ProfileRecord } from "../domain/profiles";
import type { RoutinesService } from "./scheduling/routines-service";
import { ConversationStore } from "./conversation/conversation-store";
import { MemoryService } from "./memory-service";
import { ModelService } from "./models/model-service";
import { telemetry } from "./infrastructure/telemetry";
import { createTraceSpan } from "../utils/telemetry-helpers";
import { ReflectionPromptService } from "./reflection-prompt-service";
import { ReflectionStateService } from "./reflection-state-service";
import { nowInTimezone, localDateKey, startOfDay as startOfLocalDay } from "../utils/time-helpers";

export type ReflectionTrigger = "daily" | "compaction" | "explicit";

export type ReflectionEntry = {
  occurredAt: string;
  localDate: string;
  trigger: ReflectionTrigger;
  mood: string;
  bringUpNextTime?: string;
  body: string;
};

type ReflectionResponse = {
  body?: string;
  mood?: string;
  bring_up_next_time?: string;
};

const MAX_RECENT_HISTORY_ENTRIES = 18;
const MAX_BOOTSTRAP_ENTRIES = 3;
const reflectionTelemetry = telemetry.child({ component: "reflection" });

const traceSpan = createTraceSpan(reflectionTelemetry);

function stripCodeFence(text: string) {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonObject(text: string) {
  const cleaned = stripCodeFence(text);
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

function compactText(text: string, maxChars: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function parseJournalEntries(raw: string): ReflectionEntry[] {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const chunks = normalized.split(/^##\s+/m).filter(Boolean);
  const entries: ReflectionEntry[] = [];
  for (const chunk of chunks) {
    const [headerLine, ...rest] = chunk.split("\n");
    const header = headerLine?.trim() ?? "";
    const headerMatch = header.match(/^([0-9T:\-+.Z]+)\s+\[(daily|compaction|explicit)\]$/);
    if (!headerMatch) {
      continue;
    }

    let mood = "";
    let bringUpNextTime = "";
    const bodyLines: string[] = [];
    for (const line of rest) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- mood:")) {
        mood = trimmed.replace(/^- mood:\s*/, "").trim();
        continue;
      }
      if (trimmed.startsWith("- bring_up_next_time:")) {
        bringUpNextTime = trimmed.replace(/^- bring_up_next_time:\s*/, "").trim();
        continue;
      }
      bodyLines.push(line);
    }

    const occurredAt = headerMatch[1] ?? "";
    entries.push({
      occurredAt,
      localDate: localDateKey(new Date(occurredAt)),
      trigger: headerMatch[2] as ReflectionTrigger,
      mood: mood || "uncertain",
      bringUpNextTime: bringUpNextTime || undefined,
      body: bodyLines.join("\n").trim(),
    });
  }
  return entries.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
}

function renderJournal(entries: ReflectionEntry[]) {
  if (entries.length === 0) {
    return "";
  }
  return `${entries.map((entry) => [
    `## ${entry.occurredAt} [${entry.trigger}]`,
    "",
    `- mood: ${entry.mood}`,
    `- bring_up_next_time: ${entry.bringUpNextTime ?? ""}`,
    "",
    entry.body.trim(),
    "",
  ].join("\n").trimEnd()).join("\n\n")}\n`;
}

function formatRecentHistory(entries: Awaited<ReturnType<ConversationStore["listRecentHistory"]>>) {
  if (entries.length === 0) {
    return "(no recent archived conversation entries)";
  }
  return entries
    .map((entry) =>
      [
        `[${entry.occurredAt}] ${entry.role} (${entry.conversationKey} #${entry.messageIndex})`,
        compactText(entry.text, 320),
      ].join("\n")
    )
    .join("\n\n");
}

export class ReflectionService {
  private queuedJob: Promise<void> = Promise.resolve();
  private readonly state = new ReflectionStateService();
  private readonly prompts = new ReflectionPromptService();

  constructor(
    private readonly profile: ProfileRecord,
    private readonly routines: RoutinesService,
    private readonly conversations: ConversationStore,
    private readonly memory: MemoryService,
    private readonly models: Pick<ModelService, "generateMemoryText" | "getReflectionSelection">,
    private readonly soul?: Pick<import("./soul-service").SoulService, "queueScheduledRewriteIfEligible">,
  ) {}

  isDailyReflectionEligible(reference: Date = new Date()) {
    const timezone = this.routines.loadData().settings.timezone;
    const localNow = nowInTimezone(timezone, reference);
    if (localNow.getHours() < 18) {
      return false;
    }
    const localDate = localDateKey(localNow);
    const state = this.state.getProfileState(this.profile);
    return state.lastDailyLocalDate !== localDate;
  }

  async buildThreadBootstrapContext() {
    const entries = (await this.readJournalEntries()).slice(-MAX_BOOTSTRAP_ENTRIES);
    if (entries.length === 0) {
      return "";
    }

    const latest = entries.at(-1);
    const initiativeSeed = [...entries]
      .reverse()
      .find((entry) => entry.bringUpNextTime?.trim())?.bringUpNextTime?.trim();

    const sections = [
      "## Reflection Continuity",
      ...entries.map((entry, index) => [
        `### Journal ${index + 1}`,
        `time: ${entry.occurredAt}`,
        `trigger: ${entry.trigger}`,
        `mood: ${entry.mood}`,
        entry.bringUpNextTime ? `bring_up_next_time: ${entry.bringUpNextTime}` : "",
        compactText(entry.body, 700),
      ].filter(Boolean).join("\n")),
    ];

    if (latest?.mood) {
      sections.push(`Last mood continuity: ${latest.mood}.`);
    }
    if (initiativeSeed) {
      sections.push(`Initiative seed: you had something on your mind to bring up next time: ${initiativeSeed}`);
    }

    return sections.join("\n\n");
  }

  async runExplicitReflection(params?: { focus?: string; reference?: Date }) {
    return this.runReflection({
      trigger: "explicit",
      reference: params?.reference ?? new Date(),
      focus: params?.focus,
    });
  }

  queueCompactionReflection(params: {
    summary: string;
    conversationKey: string;
    reference?: Date;
  }) {
    this.enqueue(async () => {
      await this.runReflection({
        trigger: "compaction",
        reference: params.reference ?? new Date(),
        focus: `Conversation compaction for ${params.conversationKey}`,
        suppliedContext: `Compaction summary:\n${params.summary.trim()}`,
      });
    });
  }

  queueDailyReflectionIfEligible(reference: Date = new Date()) {
    if (!this.isDailyReflectionEligible(reference)) {
      return;
    }
    this.enqueue(async () => {
      if (!this.isDailyReflectionEligible(reference)) {
        return;
      }
      const timezone = this.routines.loadData().settings.timezone;
      const localNow = nowInTimezone(timezone, reference);
      const localDate = localDateKey(localNow);
      const result = await this.runReflection({
        trigger: "daily",
        reference,
      });
      if (result) {
        this.state.updateProfileState(this.profile, (current) => ({
          ...current,
          lastDailyLocalDate: localDate,
        }));
        this.soul?.queueScheduledRewriteIfEligible(reference);
      }
    });
  }

  private enqueue(job: () => Promise<void>) {
    this.queuedJob = this.queuedJob
      .catch(() => undefined)
      .then(job)
      .catch((error) => {
        reflectionTelemetry.recordError(error, {
          profileId: this.profile.id,
          operation: "reflection.queue",
        });
      });
  }

  private async runReflection(params: {
    trigger: ReflectionTrigger;
    reference: Date;
    focus?: string;
    suppliedContext?: string;
  }) {
    return traceSpan(
      "reflection.run",
      async () => {
        const timezone = this.routines.loadData().settings.timezone;
        const localNow = nowInTimezone(timezone, params.reference);
        const localDate = localDateKey(localNow);
        const recentEntries = (await this.readJournalEntries()).slice(-2);
        const soul = await this.memory.readProfileDocument("identity/SOUL.md");
        const since = params.trigger === "daily"
          ? startOfLocalDay(localNow).toISOString()
          : undefined;
        const recentHistory = params.suppliedContext?.trim()
          ? params.suppliedContext.trim()
          : formatRecentHistory(await this.conversations.listRecentHistory({
              limit: MAX_RECENT_HISTORY_ENTRIES,
              since,
            }));
        const reflectionPrompt = this.prompts.buildReflectionSystemPrompt();

        const responseText = await this.models.generateMemoryText({
          systemPrompt: reflectionPrompt.text,
          userPrompt: [
            `Trigger: ${params.trigger}`,
            `Occurred at: ${params.reference.toISOString()}`,
            `Local date: ${localDate}`,
            params.focus?.trim() ? `Focus: ${params.focus.trim()}` : "",
            "",
            "Recent context:",
            recentHistory,
            "",
            "Last journal entries:",
            recentEntries.length > 0
              ? recentEntries.map((entry) =>
                  [
                    `- ${entry.occurredAt} [${entry.trigger}]`,
                    `  mood: ${entry.mood}`,
                    entry.bringUpNextTime ? `  bring_up_next_time: ${entry.bringUpNextTime}` : "",
                    `  ${compactText(entry.body, 280)}`,
                  ]
                    .filter(Boolean)
                    .join("\n")
                ).join("\n")
              : "(none)",
            "",
            "Current self-model:",
            soul?.trim() || "(none)",
          ].filter(Boolean).join("\n"),
          usagePurpose: `reflection_${params.trigger}`,
          sessionIdPrefix: `reflection-${params.trigger}`,
          selection: this.models.getReflectionSelection(),
        });

        const parsed = JSON.parse(extractJsonObject(responseText)) as ReflectionResponse;
        const body = parsed.body?.trim();
        if (!body) {
          return null;
        }

        const occurredAt = params.reference.toISOString();
        const nextEntry: ReflectionEntry = {
          occurredAt,
          localDate,
          trigger: params.trigger,
          mood: parsed.mood?.trim() || "uncertain",
          bringUpNextTime: parsed.bring_up_next_time?.trim() || undefined,
          body,
        };
        const entries = (await this.readJournalEntries()).concat(nextEntry);
        const content = renderJournal(entries);
        const filePath = await this.memory.upsertProfileDocument({
          relativePath: "identity/JOURNAL.md",
          content,
        });
        return {
          entry: nextEntry,
          filePath,
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

  private async readJournalEntries() {
    const raw = await this.memory.readProfileDocument("identity/JOURNAL.md");
    return parseJournalEntries(raw ?? "");
  }
}
