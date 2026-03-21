import { TelemetryStore, type TelemetryQueryParams } from "./telemetry-store";
import { TelemetryService, telemetry } from "./telemetry";

type TelemetryQueryFormat = "text" | "json";

export type TelemetryQueryInput = Omit<TelemetryQueryParams, "limit"> & {
  limit?: number;
  format?: TelemetryQueryFormat;
};

function formatSpan(entry: ReturnType<TelemetryStore["query"]>["spans"][number]) {
  return [
    `[span] ${entry.startedAt} ${entry.component}.${entry.operation}`,
    `trace=${entry.traceId}`,
    `span=${entry.spanId}`,
    entry.parentSpanId ? `parent=${entry.parentSpanId}` : "",
    `outcome=${entry.outcome}`,
    `durationMs=${entry.durationMs.toFixed(2)}`,
    entry.conversationKey ? `conversationKey=${entry.conversationKey}` : "",
    entry.workflowRunId ? `workflowRunId=${entry.workflowRunId}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function formatEvent(entry: ReturnType<TelemetryStore["query"]>["events"][number]) {
  return [
    `[event] ${entry.timestamp} ${entry.component}.${entry.eventName}`,
    entry.traceId ? `trace=${entry.traceId}` : "",
    entry.spanId ? `span=${entry.spanId}` : "",
    `severity=${entry.severity}`,
    entry.outcome ? `outcome=${entry.outcome}` : "",
    entry.message ? `message=${entry.message}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export class TelemetryQueryService {
  constructor(
    private readonly store = new TelemetryStore(),
    private readonly telemetryService: TelemetryService = telemetry.child({ component: "tool" }),
  ) {}

  async query(input: TelemetryQueryInput) {
    return this.telemetryService.span(
      "tool.telemetry_query",
      input,
      async () => {
        const limit = input.limit ?? 50;
        if (limit < 1) {
          throw new Error("limit must be greater than or equal to 1");
        }
        const results = this.store.query({
          ...input,
          outcome: input.outcome ?? "all",
          level: input.level ?? "all",
          limit,
        });
        const totalMatches = results.spans.length + results.events.length;
        const truncated = totalMatches >= limit;

        if (input.format === "json") {
          return {
            spans: results.spans,
            events: results.events,
            totalMatches,
            truncated,
          };
        }

        if (totalMatches === 0) {
          return "No telemetry records matched.";
        }

        const timeline = [
          ...results.spans.map((entry) => ({
            timestamp: entry.startedAt,
            line: formatSpan(entry),
          })),
          ...results.events.map((entry) => ({
            timestamp: entry.timestamp,
            line: formatEvent(entry),
          })),
        ]
          .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
          .slice(0, limit)
          .map((entry) => entry.line);

        return [
          `Matches: ${timeline.length}${truncated ? ` of ${totalMatches}` : ""}`,
          "Timeline:",
          timeline.join("\n"),
        ].join("\n");
      },
    );
  }
}
