import type { ProfileRecord } from "../domain/profiles";
import type { ConversationStore } from "./conversation/conversation-store";
import type { MemoryService } from "./memory-service";
import type { ModelService } from "./models/model-service";
import type { RoutinesService } from "./scheduling/routines-service";
import { wrapInjectedMessage } from "./injected-message-service";
import { formatLocalTime } from "./local-time-service";
import { AutonomousTimePromptService } from "./autonomous-time-prompt-service";
import { AutonomousTimeStateService } from "./autonomous-time-state-service";
import { nowInTimezone, localDateKey } from "../utils/time-helpers";
import { getRuntimeConfig } from "../config/runtime-config";
import { telemetry } from "./infrastructure/telemetry";
import { createTraceSpan } from "../utils/telemetry-helpers";

const AUTONOMOUS_TIME_HOUR = 4;
const MAX_RECENT_JOURNAL_CHARS = 12_000;
const MAX_BOOTSTRAP_ENTRIES = 3;

const autonomousTimeTelemetry = telemetry.child({ component: "autonomous_time" });
const traceSpan = createTraceSpan(autonomousTimeTelemetry);

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

const MOOD_WORDS = ["happy", "sad", "anxious", "calm", "excited", "frustrated",
  "curious", "content", "thoughtful", "reflective", "uncertain", "hopeful",
  "tired", "energetic", "grateful", "melancholy", "optimistic", "overwhelmed"];

function localDateParts(reference: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(reference);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error(`Unable to resolve local date in timezone ${timezone}.`);
  }
  return { year, month, day };
}

function resolveTimezoneOffsetMinutes(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const token = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  const match = token.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) {
    return 0;
  }
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2] ?? "0", 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  return sign * (hours * 60 + minutes);
}

function buildLocalOccurrence(reference: Date, timezone: string, hours: number, minutes = 0) {
  const dateParts = localDateParts(reference, timezone);
  const baseUtc = Date.UTC(
    Number.parseInt(dateParts.year, 10),
    Number.parseInt(dateParts.month, 10) - 1,
    Number.parseInt(dateParts.day, 10),
    hours,
    minutes,
    0,
    0,
  );
  return new Date(baseUtc - resolveTimezoneOffsetMinutes(new Date(baseUtc), timezone) * 60_000);
}

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

/**
 * Parse model response text into a ReflectionResponse.
 * Falls back to heuristic extraction when JSON parsing fails.
 * Returns null if the response is empty.
 */
export function parseReflectionText(responseText: string): ReflectionResponse | null {
  try {
    return JSON.parse(extractJsonObject(responseText)) as ReflectionResponse;
  } catch {
    const heuristicBody = responseText.trim();
    if (!heuristicBody) {
      return null;
    }
    const lowerText = heuristicBody.toLowerCase();
    const detectedMood = MOOD_WORDS.find((w) => lowerText.includes(w)) || "uncertain";
    return { body: heuristicBody, mood: detectedMood };
  }
}

function compactText(text: string, maxChars: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function compactTail(text: string, maxChars: number) {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(Math.max(0, normalized.length - maxChars)).trimStart();
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

function formatRecentHistory() {
  return "(no recent archived conversation entries)";
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

const SOUL_REWRITE_INTERVAL_DAYS = 7;

export class AutonomousTimeService {
  private readonly state = new AutonomousTimeStateService();
  private readonly prompts = new AutonomousTimePromptService();
  private queuedJob: Promise<void> = Promise.resolve();

  constructor(
    private readonly profile: ProfileRecord,
    private readonly routines: Pick<RoutinesService, "loadData" | "getTimezone">,
    private readonly conversations: ConversationStore,
    private readonly memory: MemoryService,
    private readonly models: Pick<ModelService, "generateMemoryText" | "getReflectionSelection">,
  ) {}

  // ---------------------------------------------------------------------------
  // Autonomous-time scheduling (the main trigger)
  // ---------------------------------------------------------------------------

  isEnabled() {
    return getRuntimeConfig().autonomousTime.enabled;
  }

  isEligible(reference: Date = new Date()) {
    if (!this.isEnabled()) {
      return false;
    }
    const timezone = this.routines.loadData().settings.timezone;
    const localNow = nowInTimezone(timezone, reference);
    if (localNow.getHours() < AUTONOMOUS_TIME_HOUR) {
      return false;
    }
    const localDate = localDateKey(localNow);
    return this.state.getProfileState(this.profile).lastTriggeredLocalDate !== localDate;
  }

  getTriggerLocalDate(reference: Date = new Date()) {
    const timezone = this.routines.loadData().settings.timezone;
    return localDateKey(nowInTimezone(timezone, reference));
  }

  getNextRunAt(reference: Date = new Date()) {
    if (!this.isEnabled()) {
      return null;
    }
    if (this.isEligible(reference)) {
      return reference;
    }

    const timezone = this.routines.loadData().settings.timezone;
    const nextReference = new Date(reference);
    const todayAtFour = buildLocalOccurrence(reference, timezone, AUTONOMOUS_TIME_HOUR);
    if (reference.getTime() < todayAtFour.getTime()) {
      return todayAtFour;
    }
    nextReference.setDate(nextReference.getDate() + 1);
    return buildLocalOccurrence(nextReference, timezone, AUTONOMOUS_TIME_HOUR);
  }

  markTriggered(reference: Date = new Date()) {
    const localDate = this.getTriggerLocalDate(reference);
    this.state.updateProfileState(this.profile, (current) => ({
      ...current,
      lastTriggeredLocalDate: localDate,
    }));
    return localDate;
  }

  async buildInjectedMessage(reference: Date = new Date()) {
    const timezone = this.routines.loadData().settings.timezone;
    const snapshot = await this.prompts.load();
    return {
      snapshot,
      text: wrapInjectedMessage("autonomous_time", [
        "Autonomous-time trigger. This is a private internal session, not a user-authored message.",
        `Triggered at: ${reference.toISOString()}`,
        `Current local time: ${formatLocalTime(reference, timezone)}`,
        `Autonomous-time instructions from ${snapshot.path}:`,
        snapshot.text,
      ].join("\n\n")),
    };
  }

  // ---------------------------------------------------------------------------
  // Reflection capabilities (formerly ReflectionService)
  // ---------------------------------------------------------------------------

  isDailyReflectionEligible(reference: Date = new Date()) {
    const timezone = this.routines.loadData().settings.timezone;
    const localNow = nowInTimezone(timezone, reference);
    if (localNow.getHours() < 18) {
      return false;
    }
    const localDate = localDateKey(localNow);
    const state = this.state.getProfileState(this.profile);
    return state.lastReflectionLocalDate !== localDate;
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
          lastReflectionLocalDate: localDate,
        }));
        this.queueScheduledSoulRewriteIfEligible(reference);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Soul rewrite capabilities (formerly SoulService)
  // ---------------------------------------------------------------------------

  isScheduledSoulRewriteEligible(reference: Date = new Date()) {
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

  queueScheduledSoulRewriteIfEligible(reference: Date = new Date()) {
    if (!this.isScheduledSoulRewriteEligible(reference)) {
      return;
    }
    this.enqueue(async () => {
      if (!this.isScheduledSoulRewriteEligible(reference)) {
        return;
      }
      await this.runSoulRewrite({
        trigger: "scheduled",
        reference,
      });
    });
  }

  async runExplicitSoulRewrite(params?: { focus?: string; reference?: Date }) {
    return this.runSoulRewrite({
      trigger: "explicit",
      reference: params?.reference ?? new Date(),
      focus: params?.focus,
    });
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private enqueue(job: () => Promise<void>) {
    this.queuedJob = this.queuedJob
      .catch(() => undefined)
      .then(job)
      .catch((error) => {
        autonomousTimeTelemetry.recordError(error, {
          profileId: this.profile.id,
          operation: "autonomous_time.queue",
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
      "autonomous_time.reflection",
      async () => {
        const timezone = this.routines.loadData().settings.timezone;
        const localNow = nowInTimezone(timezone, params.reference);
        const localDate = localDateKey(localNow);
        const recentEntries = (await this.readJournalEntries()).slice(-2);
        const soul = await this.memory.readProfileDocument("identity/SOUL.md");
        const recentHistory = params.suppliedContext?.trim()
          ? params.suppliedContext.trim()
          : formatRecentHistory();
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

        const parsed = parseReflectionText(responseText);
        if (!parsed) {
          autonomousTimeTelemetry.event("autonomous_time.reflection.parse_failed", {
            reason: "empty_response",
            responseLength: responseText.length,
          });
          return null;
        }
        // Log when heuristic fallback was used (no valid JSON found)
        try {
          JSON.parse(extractJsonObject(responseText));
        } catch {
          autonomousTimeTelemetry.event("autonomous_time.reflection.parse_failed", {
            reason: "non_json_response",
            responseLength: responseText.length,
            heuristicMood: parsed.mood || "uncertain",
          });
        }
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

  private async runSoulRewrite(params: {
    trigger: "scheduled" | "explicit";
    reference: Date;
    focus?: string;
  }) {
    return traceSpan(
      "autonomous_time.soul_rewrite",
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

  private async readJournalEntries() {
    const raw = await this.memory.readProfileDocument("identity/JOURNAL.md");
    return parseJournalEntries(raw ?? "");
  }
}
