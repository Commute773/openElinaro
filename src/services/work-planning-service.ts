import type { ProjectRecord, WorkPriority } from "../domain/projects";
import type { RoutineItem, RoutineSchedule } from "../domain/routines";
import { ProjectsService } from "./projects-service";
import { RoutinesService } from "./scheduling/routines-service";
import { nowInTimezone, parseTime, startOfDay } from "../utils/time-helpers";

type WorkMode = "work" | "sleep" | "personal";
type DueBucket = "overdue" | "today" | "soon" | "later" | "backlog";

export type RankedWorkItem = {
  item: RoutineItem;
  bucket: DueBucket;
  dueAt?: string;
  project?: ProjectRecord;
  jobPriority?: WorkPriority;
  projectPriority?: WorkPriority;
};

export type WorkPlanSnapshot = {
  mode: WorkMode;
  activeJobIds: string[];
  items: RankedWorkItem[];
  currentFocus?: RankedWorkItem;
  queue: RankedWorkItem[];
  topProjects: ProjectRecord[];
  hasDuePressure: boolean;
  hasExplicitInProgress: boolean;
};

function toTimezoneDate(date: Date, timezone: string) {
  return new Date(date.toLocaleString("en-US", { timeZone: timezone }));
}

function parseIso(value?: string) {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function minutesSinceMidnight(date: Date) {
  return date.getHours() * 60 + date.getMinutes();
}

function isWithinTimeBlock(
  date: Date,
  block: {
    days: string[];
    start: string;
    end: string;
  },
) {
  const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][date.getDay()]!;
  if (!block.days.includes(weekday)) {
    return false;
  }

  const start = parseTime(block.start);
  const end = parseTime(block.end);
  const currentMinutes = minutesSinceMidnight(date);
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;

  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function priorityScore(priority?: WorkPriority) {
  switch (priority) {
    case "urgent":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    default:
      return 1;
  }
}

function getDueAt(schedule: RoutineSchedule) {
  if (schedule.kind !== "once") {
    return undefined;
  }
  return parseIso(schedule.dueAt);
}

function dueBucket(
  dueAt: Date | undefined,
  referenceNow: Date,
  timezoneNow: Date,
  timezone: string,
): DueBucket {
  if (!dueAt) {
    return "backlog";
  }
  if (dueAt.getTime() < referenceNow.getTime()) {
    return "overdue";
  }

  const dueDay = startOfDay(toTimezoneDate(dueAt, timezone));
  const today = startOfDay(timezoneNow);
  const deltaDays = Math.floor((dueDay.getTime() - today.getTime()) / 86_400_000);

  if (deltaDays <= 0) {
    return "today";
  }
  if (deltaDays <= 3) {
    return "soon";
  }
  return "later";
}

function bucketRank(bucket: DueBucket) {
  switch (bucket) {
    case "overdue":
      return 0;
    case "today":
      return 1;
    case "soon":
      return 2;
    case "later":
      return 3;
    case "backlog":
      return 4;
  }
}

function hasInProgressLabel(item: RoutineItem) {
  return item.labels?.some((label) => ["in-progress", "focus"].includes(label.trim().toLowerCase())) ?? false;
}

function formatDueBucket(entry: RankedWorkItem) {
  if (!entry.dueAt) {
    return "backlog";
  }
  switch (entry.bucket) {
    case "overdue":
      return `overdue (${entry.dueAt})`;
    case "today":
      return `due today (${entry.dueAt})`;
    case "soon":
      return `due soon (${entry.dueAt})`;
    case "later":
      return `due later (${entry.dueAt})`;
    case "backlog":
      return "backlog";
  }
}

export class WorkPlanningService {
  constructor(
    private readonly routines: RoutinesService,
    private readonly projects: ProjectsService,
  ) {}

  getSnapshot(reference: Date = new Date()): WorkPlanSnapshot {
    const data = this.routines.loadData();
    const timezoneNow = nowInTimezone(data.settings.timezone, reference);
    const mode: WorkMode = isWithinTimeBlock(timezoneNow, data.settings.workBlock)
      ? "work"
      : isWithinTimeBlock(timezoneNow, data.settings.sleepBlock)
        ? "sleep"
        : "personal";

    const activeJobs = this.projects.listJobs({ status: "active" }).filter((job) =>
      !(job.availabilityBlocks ?? []).some((block) => {
        const startAt = parseIso(block.startAt);
        const endAt = parseIso(block.endAt);
        return startAt
          && endAt
          && reference.getTime() >= startAt.getTime()
          && reference.getTime() <= endAt.getTime();
      }));
    const activeJobIds = activeJobs.map((job) => job.id);
    const activeProjects = this.projects.listProjects({ status: "active" });

    const ranked = this.routines.listItems({
      status: "all",
      scope: "work",
    })
      .filter((item) => item.status === "active")
      .map((item) => {
        const project = item.projectId ? this.projects.getProject(item.projectId) : undefined;
        const projectPriority = project?.priority;
        const jobPriority = item.jobId ? this.projects.getJob(item.jobId)?.priority : project?.jobId ? this.projects.getJob(project.jobId)?.priority : undefined;
        return {
          item,
          bucket: dueBucket(
            getDueAt(item.schedule),
            reference,
            timezoneNow,
            data.settings.timezone,
          ),
          dueAt: getDueAt(item.schedule)?.toISOString(),
          project,
          projectPriority,
          jobPriority,
        } satisfies RankedWorkItem;
      })
      .filter((entry) => {
        if (entry.project && !activeProjects.some((project) => project.id === entry.project!.id)) {
          return false;
        }
        if (entry.item.jobId) {
          return activeJobIds.includes(entry.item.jobId);
        }
        if (entry.project?.jobId) {
          return activeJobIds.includes(entry.project.jobId);
        }
        return true;
      })
      .sort((left, right) => {
        const bucketDelta = bucketRank(left.bucket) - bucketRank(right.bucket);
        if (bucketDelta !== 0) {
          return bucketDelta;
        }
        const itemPriorityDelta = priorityScore(right.item.priority) - priorityScore(left.item.priority);
        if (itemPriorityDelta !== 0) {
          return itemPriorityDelta;
        }
        const projectPriorityDelta = priorityScore(right.projectPriority) - priorityScore(left.projectPriority);
        if (projectPriorityDelta !== 0) {
          return projectPriorityDelta;
        }
        const jobPriorityDelta = priorityScore(right.jobPriority) - priorityScore(left.jobPriority);
        if (jobPriorityDelta !== 0) {
          return jobPriorityDelta;
        }
        if (left.dueAt && right.dueAt && left.dueAt !== right.dueAt) {
          return left.dueAt.localeCompare(right.dueAt);
        }
        return left.item.title.localeCompare(right.item.title);
      });

    const explicitFocus = ranked.find((entry) => hasInProgressLabel(entry.item));
    const currentFocus = explicitFocus ?? ranked[0];
    const queue = ranked.filter((entry) => entry.item.id !== currentFocus?.item.id).slice(0, 3);
    const topProjects = Array.from(
      new Map(
        ranked
          .map((entry) => entry.project)
          .filter((project): project is ProjectRecord => Boolean(project))
          .map((project) => [project.id, project]),
      ).values(),
    ).slice(0, 3);

    return {
      mode,
      activeJobIds,
      items: ranked,
      currentFocus,
      queue,
      topProjects,
      hasDuePressure: ranked.some((entry) => ["overdue", "today"].includes(entry.bucket)),
      hasExplicitInProgress: Boolean(explicitFocus),
    };
  }

  buildAssistantContext(reference: Date = new Date()) {
    const snapshot = this.getSnapshot(reference);
    const hasOverdueWork = snapshot.items.some((entry) => entry.bucket === "overdue");
    if (snapshot.mode !== "work" && !hasOverdueWork) {
      return `Work context: outside work mode. Open work items: ${snapshot.items.length}.`;
    }
    if (snapshot.items.length === 0) {
      return `Work context: ${snapshot.mode} mode with no active work-scoped items.`;
    }

    return [
      `Work context mode: ${snapshot.mode}.`,
      snapshot.activeJobIds.length > 0
        ? `Active jobs: ${snapshot.activeJobIds.join(", ")}.`
        : "Active jobs: none.",
      snapshot.currentFocus
        ? `Current focus: ${snapshot.currentFocus.item.title}${snapshot.currentFocus.project ? ` [${snapshot.currentFocus.project.id}]` : ""} (${formatDueBucket(snapshot.currentFocus)}).`
        : "Current focus: none.",
      snapshot.queue.length > 0
        ? `Next queue: ${snapshot.queue.map((entry) =>
            `${entry.item.title}${entry.project ? ` [${entry.project.id}]` : ""} (${formatDueBucket(entry)})`).join("; ")}.`
        : "Next queue: none.",
    ].join("\n");
  }

  buildSummary(reference: Date = new Date()) {
    const snapshot = this.getSnapshot(reference);
    if (snapshot.items.length === 0) {
      return `Work summary: ${snapshot.mode} mode with no active work-scoped items.`;
    }

    const lines = [
      `Work mode: ${snapshot.mode}`,
      `Active jobs: ${snapshot.activeJobIds.join(", ") || "(none)"}`,
    ];
    if (snapshot.currentFocus) {
      lines.push(
        `Current focus: ${snapshot.currentFocus.item.id} | ${snapshot.currentFocus.item.title} | ${formatDueBucket(snapshot.currentFocus)}`,
      );
    }
    if (snapshot.topProjects.length > 0) {
      lines.push(`Top projects: ${snapshot.topProjects.map((project) => `${project.id}/${project.priority}`).join(", ")}`);
    }
    for (const entry of snapshot.queue) {
      lines.push(`- ${entry.item.id} | ${entry.item.title} | ${formatDueBucket(entry)}`);
    }
    return lines.join("\n");
  }

  buildHeartbeatSummary(reference: Date = new Date()) {
    const snapshot = this.getSnapshot(reference);
    if (snapshot.mode !== "work") {
      return null;
    }
    if (!snapshot.hasDuePressure && snapshot.hasExplicitInProgress) {
      return null;
    }
    if (snapshot.items.length === 0) {
      return null;
    }

    const lines = [
      `Work focus (${snapshot.activeJobIds.join(", ") || "no active job"}):`,
    ];
    if (snapshot.currentFocus) {
      lines.push(
        `- Now: ${snapshot.currentFocus.item.title}${snapshot.currentFocus.project ? ` [${snapshot.currentFocus.project.id}]` : ""} (${formatDueBucket(snapshot.currentFocus)})`,
      );
    }
    for (const entry of snapshot.queue.slice(0, 2)) {
      lines.push(`- Next: ${entry.item.title}${entry.project ? ` [${entry.project.id}]` : ""} (${formatDueBucket(entry)})`);
    }
    return lines.join("\n");
  }
}
