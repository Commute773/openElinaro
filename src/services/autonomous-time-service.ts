import type { ProfileRecord } from "../domain/profiles";
import type { RoutinesService } from "./scheduling/routines-service";
import { formatLocalTime } from "./local-time-service";
import { AutonomousTimePromptService } from "./autonomous-time-prompt-service";
import { AutonomousTimeStateService } from "./autonomous-time-state-service";
import { nowInTimezone, localDateKey } from "../utils/time-helpers";
import { getRuntimeConfig } from "../config/runtime-config";

const AUTONOMOUS_TIME_HOUR = 4;

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

export class AutonomousTimeService {
  private readonly state = new AutonomousTimeStateService();
  private readonly prompts = new AutonomousTimePromptService();

  constructor(
    private readonly profile: ProfileRecord,
    private readonly routines: Pick<RoutinesService, "loadData">,
  ) {}

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
      text: [
        "Autonomous-time trigger. This is a private internal session, not a user-authored message.",
        `Triggered at: ${reference.toISOString()}`,
        `Current local time: ${formatLocalTime(reference, timezone)}`,
        `Autonomous-time instructions from ${snapshot.path}:`,
        snapshot.text,
      ].join("\n\n"),
    };
  }
}
