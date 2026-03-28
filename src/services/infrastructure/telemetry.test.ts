import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

let previousCwd = "";
let tempRoot = "";

beforeEach(() => {
  previousCwd = process.cwd();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-telemetry-"));
  process.chdir(tempRoot);
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "logs"), { recursive: true });
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

describe("TelemetryService", () => {
  test("writes spans and events to the sqlite telemetry store", async () => {
    const { TelemetryStore } = await import("../telemetry-store");
    const { TelemetryService } = await import("./telemetry");

    const store = new TelemetryStore(path.join(tempRoot, ".openelinarotest", "telemetry.sqlite"));
    const service = new TelemetryService(store);
    await service.run({ workflowRunId: "run-1" }, async () => {
      await service.span("workflow.run", async () => {
        service.event("workflow.task.warning", { taskId: "task-1" }, { level: "warn" });
      });
    });

    const results = store.query({ workflowRunId: "run-1", limit: 20 });
    expect(results.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        component: "workflow",
        operation: "run",
        outcome: "ok",
        workflowRunId: "run-1",
      }),
    ]));

    expect(results.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        component: "workflow",
        eventName: "task.warning",
        workflowRunId: "run-1",
        severity: "warn",
      }),
    ]));
  });

  test("auto-instruments public methods through a proxy", async () => {
    const { TelemetryStore } = await import("../telemetry-store");
    const { TelemetryService } = await import("./telemetry");

    class ExampleService {
      private value = 0;

      add(amount: number) {
        this.value += amount;
        return this.value;
      }

      async multiply(amount: number) {
        return amount * 2;
      }
    }

    const store = new TelemetryStore(path.join(tempRoot, ".openelinarotest", "telemetry.sqlite"));
    const service = new TelemetryService(store);
    const instrumented = service.instrumentMethods(new ExampleService(), {
      component: "example",
      entityType: "example_service",
      entityId: "svc-1",
    });

    expect(instrumented.add(3)).toBe(3);
    expect(await instrumented.multiply(4)).toBe(8);

    const results = store.query({
      component: "example",
      entityId: "svc-1",
      limit: 20,
    });

    expect(results.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        component: "example",
        operation: "add",
        entityType: "example_service",
        entityId: "svc-1",
        attributesJson: expect.objectContaining({
          className: "ExampleService",
          methodName: "add",
        }),
      }),
      expect.objectContaining({
        component: "example",
        operation: "multiply",
        entityType: "example_service",
        entityId: "svc-1",
        attributesJson: expect.objectContaining({
          className: "ExampleService",
          methodName: "multiply",
        }),
      }),
    ]));
  });
});
