import type { TelemetryService } from "../services/telemetry";

/**
 * Creates a bound `traceSpan` helper scoped to a telemetry child instance.
 *
 * Usage:
 *   const traceSpan = createTraceSpan(telemetry.child({ component: "my_service" }));
 *   await traceSpan("operation_name", () => doWork());
 */
export function createTraceSpan(tel: TelemetryService) {
  return function traceSpan<T>(
    operation: string,
    fn: () => Promise<T>,
    options?: { attributes?: Record<string, unknown> },
  ): Promise<T> {
    return tel.span(operation, options?.attributes ?? {}, fn);
  };
}
