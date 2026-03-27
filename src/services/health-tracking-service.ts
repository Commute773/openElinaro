import fs from "node:fs";
import path from "node:path";
import { resolveRuntimePath } from "./runtime-root";
import { timestamp as nowIso } from "../utils/timestamp";

export interface HealthCheckinInput {
  observedAt?: string;
  kind?: string;
  energy?: number;
  mood?: number;
  sleepHours?: number;
  symptoms?: string;
  dizziness?: string;
  anxiety?: number;
  caffeineMg?: number;
  dextroamphetamineMg?: number;
  heartRateBpm?: number;
  meals?: string[];
  notes?: string;
}

export interface HealthCheckinRecord extends HealthCheckinInput {
  id: string;
  observedAt: string;
  source: "structured" | "imported";
  title?: string;
  rawText?: string;
  importedFrom?: string;
}

interface HealthStoreData {
  version: number;
  checkins: HealthCheckinRecord[];
}

const STORE_VERSION = 1;


function parseScore(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const match = value.match(/(-?\d+(?:\.\d+)?)\s*\/?\s*10?/);
  if (match) {
    const parsed = Number.parseFloat(match[1] ?? "");
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const plain = Number.parseFloat(value);
  return Number.isFinite(plain) ? plain : undefined;
}

function parseNumber(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function truncate(text: string, limit = 140) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function looksLikeDatePrefix(value: string) {
  return /^\d{4}-\d{2}-\d{2}/.test(value.trim());
}

function inferKind(title: string) {
  const lower = title.toLowerCase();
  if (lower.includes("morning")) {
    return "morning";
  }
  if (lower.includes("evening")) {
    return "evening";
  }
  if (lower.includes("follow-up") || lower.includes("follow up")) {
    return "follow_up";
  }
  if (lower.includes("anxiety")) {
    return "anxiety";
  }
  return "checkin";
}

function parseObservedAt(title: string, fallbackDate?: string) {
  const dateMatch = title.match(/(\d{4}-\d{2}-\d{2})/);
  const monthNameMatch = title.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s*(\d{4})/i);
  const matchedMonthName = monthNameMatch?.[1];
  const matchedMonthDay = monthNameMatch?.[2];
  const matchedMonthYear = monthNameMatch?.[3];
  const datePart = dateMatch?.[1]
    ?? (matchedMonthName && matchedMonthDay && matchedMonthYear
      ? `${matchedMonthYear}-${({
          jan: "01",
          feb: "02",
          mar: "03",
          apr: "04",
          may: "05",
          jun: "06",
          jul: "07",
          aug: "08",
          sep: "09",
          oct: "10",
          nov: "11",
          dec: "12",
        }[matchedMonthName.slice(0, 3).toLowerCase()] ?? "01")}-${matchedMonthDay.padStart(2, "0")}`
      : fallbackDate);
  if (!datePart) {
    return nowIso();
  }

  const timeMatch = title.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  let hours = 12;
  let minutes = 0;
  if (timeMatch) {
    hours = Number.parseInt(timeMatch[1] ?? "0", 10);
    minutes = Number.parseInt(timeMatch[2] ?? "0", 10);
    const meridiem = timeMatch[3]?.toUpperCase();
    if (meridiem === "PM" && hours < 12) {
      hours += 12;
    }
    if (meridiem === "AM" && hours === 12) {
      hours = 0;
    }
  } else if (title.toLowerCase().includes("morning")) {
    hours = 9;
  } else if (title.toLowerCase().includes("evening")) {
    hours = 20;
  }

  return new Date(Date.UTC(
    Number.parseInt(datePart.slice(0, 4), 10),
    Number.parseInt(datePart.slice(5, 7), 10) - 1,
    Number.parseInt(datePart.slice(8, 10), 10),
    hours,
    minutes,
  )).toISOString();
}

function sortNewestFirst(left: HealthCheckinRecord, right: HealthCheckinRecord) {
  return right.observedAt.localeCompare(left.observedAt);
}

export class HealthTrackingService {
  private readonly storePath: string;
  private readonly importedDir: string;

  constructor(options?: { storePath?: string; importedDir?: string }) {
    this.storePath = options?.storePath ?? resolveRuntimePath("health/checkins.json");
    this.importedDir = options?.importedDir ?? resolveRuntimePath("health/imported");
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.mkdirSync(this.importedDir, { recursive: true });
    this.ensureStore();
  }

  getStorePath() {
    return this.storePath;
  }

  getImportedDir() {
    return this.importedDir;
  }

  logCheckin(input: HealthCheckinInput) {
    const store = this.loadStore();
    const checkin: HealthCheckinRecord = {
      id: `health-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      observedAt: input.observedAt ? new Date(input.observedAt).toISOString() : nowIso(),
      source: "structured",
      kind: input.kind ?? "checkin",
      energy: input.energy,
      mood: input.mood,
      sleepHours: input.sleepHours,
      symptoms: input.symptoms,
      dizziness: input.dizziness,
      anxiety: input.anxiety,
      caffeineMg: input.caffeineMg,
      dextroamphetamineMg: input.dextroamphetamineMg,
      heartRateBpm: input.heartRateBpm,
      meals: input.meals?.filter((value) => value.trim().length > 0),
      notes: input.notes,
    };
    store.checkins.push(checkin);
    store.checkins.sort(sortNewestFirst);
    this.saveStore(store);
    return checkin;
  }

  listCheckins(limit = 10): HealthCheckinRecord[] {
    return this.getAllCheckins().slice(0, Math.max(1, Math.min(limit, 100)));
  }

  history(limit = 20) {
    const checkins = this.getAllCheckins().slice(0, Math.max(1, Math.min(limit, 100)));
    if (checkins.length === 0) {
      return "(no health check-ins)";
    }
    return checkins.map((checkin) => this.formatCheckin(checkin)).join("\n");
  }

  summary() {
    const checkins = this.getAllCheckins().slice(0, 5);
    if (checkins.length === 0) {
      return "No health check-ins recorded yet.";
    }
    const latest = checkins[0];
    const lines = [
      `Latest health check-in: ${this.formatCheckin(latest!)}`,
    ];
    const trend = this.buildTrend(checkins);
    if (trend) {
      lines.push(trend);
    }
    return lines.join("\n");
  }

  buildAssistantContext() {
    const checkins = this.getAllCheckins().slice(0, 3);
    if (checkins.length === 0) {
      return "Health context: no check-ins recorded yet.";
    }
    return [
      "Health context:",
      ...checkins.map((checkin) => {
        const parts = [
          `${checkin.kind ?? "checkin"} @ ${checkin.observedAt}`,
          checkin.energy != null ? `energy ${checkin.energy}/10` : "",
          checkin.mood != null ? `mood ${checkin.mood}/10` : "",
          checkin.anxiety != null ? `anxiety ${checkin.anxiety}/10` : "",
          checkin.dizziness ? `dizziness ${checkin.dizziness}` : "",
          checkin.symptoms ? `symptoms ${truncate(checkin.symptoms, 60)}` : "",
        ].filter(Boolean);
        return `- ${parts.join(", ")}`;
      }),
    ].join("\n");
  }

  private ensureStore() {
    if (!fs.existsSync(this.storePath)) {
      this.saveStore({
        version: STORE_VERSION,
        checkins: [],
      });
    }
  }

  private loadStore(): HealthStoreData {
    const raw = JSON.parse(fs.readFileSync(this.storePath, "utf8")) as Partial<HealthStoreData>;
    return {
      version: STORE_VERSION,
      checkins: Array.isArray(raw.checkins) ? raw.checkins : [],
    };
  }

  private saveStore(store: HealthStoreData) {
    fs.writeFileSync(this.storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  }

  private getAllCheckins() {
    const structured = this.loadStore().checkins.map((checkin) => ({
      ...checkin,
      source: "structured" as const,
    }));
    const imported = this.loadImportedCheckins();
    return [...structured, ...imported].sort(sortNewestFirst);
  }

  private loadImportedCheckins() {
    if (!fs.existsSync(this.importedDir)) {
      return [] as HealthCheckinRecord[];
    }
    const files = fs.readdirSync(this.importedDir)
      .filter((name) => name.endsWith(".md"))
      .sort();
    const checkins: HealthCheckinRecord[] = [];
    for (const fileName of files) {
      const filePath = path.join(this.importedDir, fileName);
      const content = fs.readFileSync(filePath, "utf8");
      checkins.push(...this.parseImportedMarkdown(filePath, content));
    }
    return checkins;
  }

  private parseImportedMarkdown(filePath: string, content: string) {
    const blocks: Array<{ title: string; body: string[] }> = [];
    let current: { title: string; body: string[] } | null = null;
    const fallbackDate = filePath.match(/(\d{4}-\d{2}-\d{2})/)?.[1];

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("## ")) {
        if (current) {
          blocks.push(current);
        }
        current = { title: line.slice(3).trim(), body: [] };
        continue;
      }
      if (!current) {
        if (looksLikeDatePrefix(line)) {
          current = { title: line, body: [] };
        }
        continue;
      }
      current.body.push(line);
    }
    if (current) {
      blocks.push(current);
    }

    return blocks
      .map((block, index) => this.parseImportedBlock(block.title, block.body, filePath, fallbackDate, index))
      .filter((value): value is HealthCheckinRecord => value !== null);
  }

  private parseImportedBlock(
    title: string,
    body: string[],
    filePath: string,
    fallbackDate: string | undefined,
    index: number,
  ): HealthCheckinRecord | null {
    const lowerTitle = title.toLowerCase();
    const combined = body.join("\n");
    const hasStructuredSignal = /energy|mood|sleep|anxiety|orthostatic|dizziness|symptoms|meals/i.test(combined) || /check-in|checkin|anxiety/i.test(lowerTitle);
    if (!hasStructuredSignal) {
      return null;
    }

    const getValue = (label: string) => {
      const bullet = body.find((line) => line.toLowerCase().startsWith(`- **${label.toLowerCase()}:`.toLowerCase()))
        ?? body.find((line) => line.toLowerCase().startsWith(`- ${label.toLowerCase()}:`))
        ?? body.find((line) => line.toLowerCase().startsWith(`${label.toLowerCase()}:`));
      if (!bullet) {
        return undefined;
      }
      const stripped = bullet
        .replace(/^- /, "")
        .replace(/\*\*/g, "");
      const colonIndex = stripped.indexOf(":");
      return colonIndex >= 0 ? stripped.slice(colonIndex + 1).trim() : undefined;
    };

    const mealsValue = getValue("Meals");
    const observedAt = parseObservedAt(title, fallbackDate);
    return {
      id: `imported-${path.basename(filePath)}-${index}`,
      observedAt,
      source: "imported",
      importedFrom: filePath,
      title,
      kind: inferKind(title),
      energy: parseScore(getValue("Energy")),
      mood: parseScore(getValue("Mood")),
      sleepHours: parseNumber(getValue("Sleep")),
      symptoms: getValue("Symptoms") ?? getValue("Orthostatic symptoms"),
      dizziness: getValue("Orthostatic/dizziness") ?? getValue("Dizziness") ?? getValue("Orthostatic symptoms"),
      anxiety: parseScore(getValue("Anxiety")),
      caffeineMg: parseNumber(getValue("Caffeine")),
      dextroamphetamineMg: parseNumber(getValue("Dextroamphetamine")),
      heartRateBpm: parseNumber(getValue("Heart rate")),
      meals: mealsValue ? mealsValue.split(/,\s*|\s+\+\s+|\s*;\s*/).filter((value) => value.length > 0) : undefined,
      notes: getValue("Note") ?? getValue("Notes"),
      rawText: truncate(combined, 280),
    };
  }

  private buildTrend(checkins: HealthCheckinRecord[]) {
    const recentEnergy = checkins.filter((checkin) => checkin.energy != null).map((checkin) => checkin.energy as number);
    const recentMood = checkins.filter((checkin) => checkin.mood != null).map((checkin) => checkin.mood as number);
    const recentAnxiety = checkins.filter((checkin) => checkin.anxiety != null).map((checkin) => checkin.anxiety as number);
    const parts: string[] = [];
    if (recentEnergy.length > 1) {
      const average = recentEnergy.reduce((sum, value) => sum + value, 0) / recentEnergy.length;
      parts.push(`Recent energy avg ${average.toFixed(1)}/10`);
    }
    if (recentMood.length > 1) {
      const average = recentMood.reduce((sum, value) => sum + value, 0) / recentMood.length;
      parts.push(`recent mood avg ${average.toFixed(1)}/10`);
    }
    if (recentAnxiety.length > 0) {
      parts.push(`latest anxiety ${recentAnxiety[0]}/10`);
    }
    return parts.length > 0 ? parts.join("; ") : "";
  }

  private formatCheckin(checkin: HealthCheckinRecord) {
    const parts = [
      checkin.observedAt,
      checkin.kind ?? "checkin",
      checkin.energy != null ? `energy ${checkin.energy}/10` : "",
      checkin.mood != null ? `mood ${checkin.mood}/10` : "",
      checkin.anxiety != null ? `anxiety ${checkin.anxiety}/10` : "",
      checkin.dizziness ? `dizziness ${checkin.dizziness}` : "",
      checkin.sleepHours != null ? `sleep ${checkin.sleepHours}h` : "",
      checkin.meals && checkin.meals.length > 0 ? `meals ${checkin.meals.join(", ")}` : "",
      checkin.notes ? `notes ${truncate(checkin.notes, 80)}` : checkin.rawText ? `notes ${checkin.rawText}` : "",
      checkin.source === "imported" ? "(imported)" : "",
    ].filter(Boolean);
    return parts.join(" | ");
  }
}
