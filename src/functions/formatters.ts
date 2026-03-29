/**
 * Shared display formatters for domain objects.
 *
 * Used by both agent text output (agentFormat) and G2 glasses UI.
 * Each formatter produces a single-line string suitable for:
 * - G2 display rendering (one item per line)
 * - Agent tool output: items.map(formatXxx).join('\n')
 *
 * When adding a new domain, add a formatter here so both surfaces
 * get consistent formatting for free.
 */

// ---------------------------------------------------------------------------
// Routine items
// ---------------------------------------------------------------------------

export interface RoutineItemForFormat {
  id: string;
  title: string;
  kind: string;
  priority?: string;
  status?: string;
  dose?: string;
  schedule?: { kind: string; time?: string; everyDays?: number };
  state?: { lastCompletedAt?: string };
  /** From routine_check assessment */
  overdueMinutes?: number;
  dueAt?: string;
}

/**
 * Format a routine item as a single display line.
 *
 * Examples:
 *   [med] Progesterone 100mg 23:00
 *   [med!] Estradiol Valerate 6mg — 20h overdue
 *   [todo] Buy combien.ca domain
 *   [med] Dextroamphetamine 10mg 09:00 ✓
 */
export function formatRoutineItem(
  item: RoutineItemForFormat,
  opts?: { now?: Date },
): string {
  const overdue = (item.overdueMinutes ?? 0) > 0;
  const tag = `[${item.kind}${overdue ? "!" : ""}]`;

  let line = `${tag} ${item.title}`;

  if (item.dose) line += ` ${item.dose}`;

  if (item.schedule?.time) line += ` ${item.schedule.time}`;

  // ✓ if completed today
  if (item.state?.lastCompletedAt) {
    const now = opts?.now ?? new Date();
    const completed = new Date(item.state.lastCompletedAt);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    if (completed >= todayStart) line += " \u2713";
  }

  if (overdue && item.overdueMinutes) {
    line += ` \u2014 ${formatDuration(item.overdueMinutes)} overdue`;
  }

  return line;
}

// ---------------------------------------------------------------------------
// Routine check items (from routine_check assessment)
// ---------------------------------------------------------------------------

export interface CheckItemForFormat {
  id: string;
  title: string;
  kind: string;
  priority: string;
  state: string;
  overdueMinutes: number;
  dueAt?: string;
}

/**
 * Format a routine_check item for display.
 *
 * Examples:
 *   [med!] Estradiol Valerate — 20h overdue
 *   [todo] Fix CORS headers
 */
export function formatCheckItem(item: CheckItemForFormat): string {
  const overdue = item.overdueMinutes > 0;
  const tag = `[${item.kind}${overdue ? "!" : ""}]`;
  let line = `${tag} ${item.title}`;
  if (overdue) {
    line += ` \u2014 ${formatDuration(item.overdueMinutes)} overdue`;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationForFormat {
  id: string;
  type: string;
  title: string;
  body: string;
}

/**
 * Format a notification as a single display line.
 *
 * Example: Estradiol Valerate — med, 20h overdue
 */
export function formatNotification(notif: NotificationForFormat): string {
  return `${notif.title} \u2014 ${notif.body}`;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentForFormat {
  id: string;
  status: string;
  goal_truncated?: string;
  uptime?: string;
}

/**
 * Format an agent entry as a single display line.
 *
 * Example: ● agt-1a2b 12m Research Playwright…
 */
export function formatAgent(agent: AgentForFormat): string {
  const icon = agent.status === "RUNNING" ? "\u25CF" : "\u25CB";
  const time = agent.uptime ? ` ${agent.uptime}` : "";
  const goal = agent.goal_truncated ? ` ${agent.goal_truncated}` : "";
  return `${icon} ${agent.id}${time}${goal}`;
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

export interface AlarmForFormat {
  id: string;
  kind: string;
  name: string;
  triggerAt: string;
  originalSpec: string;
  state: string;
}

/**
 * Format an alarm as a single display line.
 *
 * Example: ⏰ Morning alarm 09:00
 */
export function formatAlarm(alarm: AlarmForFormat): string {
  const icon = alarm.kind === "timer" ? "\u23F1" : "\u23F0";
  return `${icon} ${alarm.name} ${alarm.originalSpec} [${alarm.state}]`;
}

// ---------------------------------------------------------------------------
// Generic formatter — universal fallback for any function result
// ---------------------------------------------------------------------------

/**
 * Format any function result as a display string.
 * Used as fallback when a function has no custom agentFormat.
 *
 * Strategy:
 * - Strings pass through
 * - Arrays: each item formatted as a line via formatResultItem
 * - Objects with an `items` array: format those items
 * - Objects: format as key: value pairs
 * - Primitives: String()
 */
export function formatResult(result: unknown): string {
  if (result === null || result === undefined) return "(no data)";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);

  if (Array.isArray(result)) {
    if (result.length === 0) return "(empty)";
    return result.map(formatResultItem).join("\n");
  }

  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;

    // Unwrap common envelopes
    if (Array.isArray(obj.items)) {
      const header = Object.entries(obj)
        .filter(([k]) => k !== "items" && k !== "agentFormat")
        .map(([k, v]) => `${humanLabel(k)}: ${formatValue(v)}`)
        .join("  ");
      const items = (obj.items as unknown[]).map(formatResultItem).join("\n");
      return header ? `${header}\n${items}` : items;
    }

    // Simple { ok: true } style
    if (Object.keys(obj).length <= 2 && "ok" in obj) {
      return obj.ok ? "Done." : `Failed: ${obj.error ?? "unknown"}`;
    }

    // Key-value rendering
    return Object.entries(obj)
      .filter(([k]) => k !== "agentFormat")
      .map(([k, v]) => `${humanLabel(k)}: ${formatValue(v)}`)
      .join("\n");
  }

  return String(result);
}

/**
 * Format a single item from a list result.
 * Prefers `display` field if present (set by domain-specific formatters).
 * Falls back to picking common identity/status/description fields.
 */
export function formatResultItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return String(item);
  const obj = item as Record<string, unknown>;

  // Prefer explicit display field
  if (typeof obj.display === "string") return obj.display;

  // Build from common fields
  const id = (obj.id ?? obj.name ?? obj.title ?? "") as string;
  const status = typeof obj.status === "string" ? ` [${obj.status}]` : "";
  const desc = (obj.description ?? obj.goal ?? obj.goal_truncated ?? obj.body ?? obj.text ?? "") as string;
  const extra = desc ? ` \u2014 ${desc.length > 50 ? desc.slice(0, 49) + "\u2026" : desc}` : "";
  return `${id}${status}${extra}`;
}

function humanLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]/g, " ")
    .trim()
    .toLowerCase();
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "\u2014";
  if (typeof val === "boolean") return val ? "yes" : "no";
  if (typeof val === "number") return String(val);
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return val.length ? `[${val.length} items]` : "[]";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatDuration(minutes: number): string {
  if (minutes >= 1440) {
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${minutes}m`;
}
