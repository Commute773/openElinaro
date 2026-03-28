export type { Weekday } from "./calendar";
import type { Weekday } from "./calendar";

export type RoutineItemKind =
  | "todo"
  | "routine"
  | "habit"
  | "med"
  | "deadline"
  | "precommitment";

export type RoutinePriority = "low" | "medium" | "high" | "urgent";

export type RoutineStatus = "active" | "paused" | "archived" | "completed";

export type RoutineSchedule =
  | { kind: "manual" }
  | { kind: "once"; dueAt: string }
  | { kind: "daily"; time: string; days?: Weekday[] }
  | { kind: "weekly"; time: string; days: Weekday[] }
  | { kind: "interval"; time: string; everyDays: number; anchorAt?: string }
  | { kind: "monthly"; time: string; dayOfMonth: number };

export interface ReminderPolicy {
  followUpMinutes: number;
  maxReminders: number;
  escalate: boolean;
}

export interface RoutineState {
  completionHistory: string[];
  lastCompletedAt?: string;
  lastSkippedAt?: string;
  skippedOccurrenceKeys: string[];
  snoozedUntil?: string;
  lastRemindedAt?: string;
  activeOccurrenceKey?: string;
  reminderCountForOccurrence: number;
}

export interface RoutineItem {
  id: string;
  profileId: string;
  title: string;
  kind: RoutineItemKind;
  priority: RoutinePriority;
  status: RoutineStatus;
  enabled: boolean;
  description?: string;
  dose?: string;
  labels?: string[];
  jobId?: string;
  projectId?: string;
  blockedBy?: string[];
  alarm?: boolean;
  schedule: RoutineSchedule;
  reminder: ReminderPolicy;
  state: RoutineState;
}

export interface TimeBlockDefinition {
  days: Weekday[];
  start: string;
  end: string;
}

export interface QuietHoursSettings {
  enabled: boolean;
  timezone: string;
  start: string;
  end: string;
}

export interface CalendarHintEvent {
  title: string;
  start: string;
  end?: string;
  location?: string;
  requiresTransit?: boolean;
}

export interface RoutineSettings {
  timezone: string;
  notificationTargetUserId?: string;
  dayResetHour?: number;
  workBlock: TimeBlockDefinition;
  sleepBlock: TimeBlockDefinition;
  quietHours: QuietHoursSettings;
}

export interface RoutineStoreData {
  settings: RoutineSettings;
  calendarEvents: CalendarHintEvent[];
  items: Record<string, RoutineItem>;
}

export interface RoutineContext {
  timezone: string;
  now: string;
  mode: "work" | "sleep" | "personal";
  transitEventTitle?: string;
}

export interface RoutineAssessment {
  item: RoutineItem;
  occurrenceKey: string;
  dueAt?: string;
  state: "due" | "upcoming" | "backlog";
  priorityScore: number;
  overdueMinutes: number;
  minutesUntilDue: number;
  reminderStage: "initial" | "follow_up" | "escalated";
  shouldRemindNow: boolean;
  attentionLevel: "required" | "optional" | "none";
  nextAttentionAt?: string;
  isManualBacklog: boolean;
  reason: string;
}

export interface HeartbeatReminderCandidate {
  itemId: string;
  profileId: string;
  title: string;
  kind: RoutineItemKind;
  priority: RoutinePriority;
  state: RoutineAssessment["state"];
  dueAt?: string;
  occurrenceKey: string;
  minutesUntilDue: number;
  overdueMinutes: number;
  reminderStage: RoutineAssessment["reminderStage"];
  reason: string;
  isManualBacklog: boolean;
}

export interface HeartbeatReminderSnapshot {
  context: RoutineContext;
  currentLocalTime: string;
  timezone: string;
  requiredCandidates: HeartbeatReminderCandidate[];
  optionalCandidates: HeartbeatReminderCandidate[];
  itemIds: string[];
  occurrenceKeys: string[];
}
