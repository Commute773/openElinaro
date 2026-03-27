import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIsolatedRuntimeRoot } from "../test/isolated-runtime-root";
import { HeartbeatService } from "./heartbeat-service";
import { resolveAssistantContextPath } from "./runtime-user-content";

const testRoot = createIsolatedRuntimeRoot("openelinaro-heartbeat-service-");
beforeEach(() => {
  testRoot.setup();
  fs.mkdirSync(path.dirname(resolveAssistantContextPath("heartbeat.md")), { recursive: true });
  fs.writeFileSync(
    resolveAssistantContextPath("heartbeat.md"),
    "# Heartbeat\n\n- Test heartbeat instructions.\n",
  );
});
afterEach(() => testRoot.teardown());

describe("HeartbeatService", () => {
  test("fallback heartbeat instructions require an email check", () => {
    fs.rmSync(resolveAssistantContextPath("heartbeat.md"), { force: true });
    const service = new HeartbeatService();

    const snapshot = service.load();

    expect(snapshot.text).toContain("email state");
    expect(snapshot.text).toContain("`email` tool");
    expect(snapshot.text).toContain("`list_unread`");
  });

  test("injects work-focus context as an internal note", () => {
    const service = new HeartbeatService();

    const text = service.buildInjectedMessage(
      new Date("2026-03-16T18:00:00.000Z"),
      {
        workFocus: "Work focus (restricted):\n- Now: Finish the operator demo.",
      },
    );

    expect(text).toContain("Automated work-focus note. This is internal context, not a user-authored message.");
    expect(text).toContain("Do not quote or dump it verbatim.");
    expect(text).toContain("Finish the operator demo.");
  });

  test("injects delivery requirements as internal runtime context", () => {
    const service = new HeartbeatService();

    const text = service.buildInjectedMessage(
      new Date("2026-03-16T18:00:00.000Z"),
      {
        deliveryRequirement: "Required reminder candidates are present right now.",
      },
    );

    expect(text).toContain("Delivery requirement. This is internal runtime context, not a user-authored message.");
    expect(text).toContain("Required reminder candidates are present right now.");
  });

  test("suppresses HEARTBEAT_OK when it appears on any non-empty line", () => {
    const service = new HeartbeatService();

    expect(service.normalizeAssistantReply("HEARTBEAT_OK\n\nextra commentary")).toBeUndefined();
    expect(service.normalizeAssistantReply("\n\nHEARTBEAT_OK\ntrailing")).toBeUndefined();
    expect(service.normalizeAssistantReply("No need to ping her.\n\nHEARTBEAT_OK")).toBeUndefined();
  });
});
