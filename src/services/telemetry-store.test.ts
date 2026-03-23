import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TelemetryEventRecord, TelemetrySpanRecord } from "./telemetry-store";

let tempRoot = "";
let previousUserDataDir: string | undefined;

function makeEventRecord(overrides: Partial<TelemetryEventRecord> = {}): TelemetryEventRecord {
  return {
    timestamp: new Date().toISOString(),
    component: "test",
    eventName: "test.event",
    severity: "info",
    serviceName: "openelinaro",
    serviceVersion: "0.0.0",
    ...overrides,
  };
}

function makeSpanRecord(overrides: Partial<TelemetrySpanRecord> = {}): TelemetrySpanRecord {
  return {
    traceId: "trace-1",
    spanId: "span-1",
    component: "test",
    operation: "test.op",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 42,
    outcome: "ok",
    level: "info",
    serviceName: "openelinaro",
    serviceVersion: "0.0.0",
    ...overrides,
  };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-telemetry-store-"));
  previousUserDataDir = process.env.OPENELINARO_USER_DATA_DIR;
  process.env.OPENELINARO_USER_DATA_DIR = tempRoot;
});

afterEach(() => {
  if (previousUserDataDir === undefined) {
    delete process.env.OPENELINARO_USER_DATA_DIR;
  } else {
    process.env.OPENELINARO_USER_DATA_DIR = previousUserDataDir;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

function logPath() {
  return path.join(tempRoot, "logs", "errors.jsonl");
}

function readLogLines(): unknown[] {
  if (!fs.existsSync(logPath())) return [];
  return fs
    .readFileSync(logPath(), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("TelemetryStore JSONL error log", () => {
  test("error-severity event writes a JSONL line", async () => {
    const { TelemetryStore } = await import("./telemetry-store");
    const store = new TelemetryStore(path.join(tempRoot, "telemetry.sqlite"));
    store.insertEvent(makeEventRecord({ severity: "error", message: "boom" }));

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "error", component: "test", event: "test.event", message: "boom" });
  });

  test("info-severity event does NOT write to the file", async () => {
    const { TelemetryStore } = await import("./telemetry-store");
    const store = new TelemetryStore(path.join(tempRoot, "telemetry.sqlite"));
    store.insertEvent(makeEventRecord({ severity: "info" }));

    expect(fs.existsSync(logPath())).toBe(false);
  });

  test("warn-severity event writes to the file", async () => {
    const { TelemetryStore } = await import("./telemetry-store");
    const store = new TelemetryStore(path.join(tempRoot, "telemetry.sqlite"));
    store.insertEvent(makeEventRecord({ severity: "warn", message: "watch out" }));

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn" });
  });

  test("error-outcome span writes to the file", async () => {
    const { TelemetryStore } = await import("./telemetry-store");
    const store = new TelemetryStore(path.join(tempRoot, "telemetry.sqlite"));
    store.insertSpan(makeSpanRecord({ outcome: "error", traceId: "t-1", spanId: "s-1" }));

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "error", component: "test", operation: "test.op", outcome: "error", traceId: "t-1", spanId: "s-1" });
  });

  test("ok-outcome span does NOT write to the file", async () => {
    const { TelemetryStore } = await import("./telemetry-store");
    const store = new TelemetryStore(path.join(tempRoot, "telemetry.sqlite"));
    store.insertSpan(makeSpanRecord({ outcome: "ok" }));

    expect(fs.existsSync(logPath())).toBe(false);
  });

  test("JSONL lines are valid JSON with expected fields", async () => {
    const { TelemetryStore } = await import("./telemetry-store");
    const store = new TelemetryStore(path.join(tempRoot, "telemetry.sqlite"));
    store.insertEvent(makeEventRecord({
      severity: "error",
      traceId: "t-2",
      spanId: "s-2",
      conversationKey: "conv-1",
      profileId: "prof-1",
      message: "detailed error",
      attributesJson: { code: 500 },
    }));

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    const line = lines[0] as Record<string, unknown>;
    expect(line.ts).toBeString();
    expect(line.level).toBe("error");
    expect(line.component).toBe("test");
    expect(line.event).toBe("test.event");
    expect(line.message).toBe("detailed error");
    expect(line.traceId).toBe("t-2");
    expect(line.spanId).toBe("s-2");
    expect(line.conversationKey).toBe("conv-1");
    expect(line.profileId).toBe("prof-1");
    expect(line.attributes).toEqual({ code: 500 });
  });

  test(":memory: mode skips file logging entirely", async () => {
    const { TelemetryStore } = await import("./telemetry-store");
    const store = new TelemetryStore(":memory:");
    store.insertEvent(makeEventRecord({ severity: "error", message: "should not appear" }));
    store.insertSpan(makeSpanRecord({ outcome: "error" }));

    expect(fs.existsSync(logPath())).toBe(false);
  });
});
