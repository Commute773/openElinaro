const FALLBACK_TIMEZONE = "UTC";

export function getLocalTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIMEZONE;
}

export function formatLocalTime(reference = new Date(), timeZone = getLocalTimezone()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(reference);
}

export function buildCurrentLocalTimePrefix(reference = new Date(), timeZone = getLocalTimezone()) {
  return `Current local time: ${formatLocalTime(reference, timeZone)} (${timeZone})`;
}
