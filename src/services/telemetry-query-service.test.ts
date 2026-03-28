import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

let previousCwd = "";
let tempRoot = "";

beforeEach(() => {
  previousCwd = process.cwd();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-telemetry-query-"));
  process.chdir(tempRoot);
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

describe("TelemetryQueryService", () => {
  test("returns combined timeline text output", async () => {
    const { TelemetryStore } = await import("./telemetry-store");
    const { TelemetryQueryService } = await import("./telemetry-query-service");
    const { TelemetryService } = await import("./infrastructure/telemetry");
    const store = new TelemetryStore(path.join(tempRoot, ".openelinarotest", "telemetry.sqlite"));
    store.insertSpan({
      traceId: "trace-1",
      spanId: "span-1",
      component: "workflow",
      operation: "run",
      startedAt: "2026-03-16T10:00:00.000Z",
      endedAt: "2026-03-16T10:00:01.000Z",
      durationMs: 1_000,
      outcome: "ok",
      level: "info",
      attributesJson: { workflowRunId: "run-1" },
      serviceName: "openelinaro",
      serviceVersion: "test",
      workflowRunId: "run-1",
    });
    store.insertEvent({
      traceId: "trace-1",
      spanId: "span-1",
      timestamp: "2026-03-16T10:00:00.500Z",
      component: "workflow",
      eventName: "task_started",
      severity: "info",
      message: "task 1 started",
      outcome: "ok",
      attributesJson: { taskId: "task-1" },
      serviceName: "openelinaro",
      serviceVersion: "test",
      workflowRunId: "run-1",
      taskId: "task-1",
    });

    const service = new TelemetryQueryService(store, new TelemetryService(store));
    const result = await service.query({ workflowRunId: "run-1", format: "text" });

    expect(result).toContain("[span] 2026-03-16T10:00:00.000Z workflow.run");
    expect(result).toContain("[event] 2026-03-16T10:00:00.500Z workflow.task_started");
  });

  test("returns structured json output", async () => {
    const { TelemetryStore } = await import("./telemetry-store");
    const { TelemetryQueryService } = await import("./telemetry-query-service");
    const { TelemetryService } = await import("./infrastructure/telemetry");
    const store = new TelemetryStore(path.join(tempRoot, ".openelinarotest", "telemetry.sqlite"));
    store.insertEvent({
      timestamp: "2026-03-16T11:00:00.000Z",
      component: "tool",
      eventName: "completed",
      severity: "info",
      message: "tool finished",
      outcome: "ok",
      attributesJson: { toolName: "read_file" },
      serviceName: "openelinaro",
      serviceVersion: "test",
      toolName: "read_file",
    });

    const service = new TelemetryQueryService(store, new TelemetryService(store));
    const result = await service.query({ toolName: "read_file", format: "json" });

    expect(result).toEqual({
      spans: [],
      events: [expect.objectContaining({ component: "tool", eventName: "completed", toolName: "read_file" })],
      totalMatches: 1,
      truncated: false,
    });
  });
});
