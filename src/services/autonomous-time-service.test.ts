import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getRuntimeConfig, saveRuntimeConfig } from "../config/runtime-config";
import type { ProfileRecord } from "../domain/profiles";
import { createIsolatedRuntimeRoot } from "../test/isolated-runtime-root";
import { AutonomousTimeService } from "./autonomous-time-service";
import { resolveAutonomousTimePromptPath } from "./autonomous-time-prompt-service";

const profile = {
  id: "root",
} as ProfileRecord;

const testRoot = createIsolatedRuntimeRoot("openelinaro-autonomous-time-");
beforeEach(() => testRoot.setup());
afterEach(() => testRoot.teardown());

describe("AutonomousTimeService", () => {
  test("becomes eligible after 4AM local time and only once per local day", () => {
    const config = getRuntimeConfig();
    saveRuntimeConfig({
      ...config,
      autonomousTime: {
        enabled: true,
        promptPath: "assistant_context/autonomous-time.md",
      },
    });

    const promptPath = resolveAutonomousTimePromptPath("assistant_context/autonomous-time.md");
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, "Write in your journal before you stop.");

    const service = new AutonomousTimeService(profile, {
      loadData: () => ({
        settings: { timezone: "America/Montreal" },
      }) as never,
    });

    const beforeFour = new Date("2026-03-22T07:59:00.000Z");
    const afterFour = new Date("2026-03-22T08:01:00.000Z");

    expect(service.isEligible(beforeFour)).toBe(false);
    expect(service.getNextRunAt(beforeFour)?.toISOString()).toBe("2026-03-22T08:00:00.000Z");

    expect(service.isEligible(afterFour)).toBe(true);
    expect(service.buildInjectedMessage(afterFour).text).toContain("Write in your journal before you stop.");

    service.markTriggered(afterFour);

    expect(service.isEligible(afterFour)).toBe(false);
    expect(service.getNextRunAt(afterFour)?.toISOString()).toBe("2026-03-23T08:00:00.000Z");
  });
});
