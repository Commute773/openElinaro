import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIsolatedRuntimeRoot } from "../test/isolated-runtime-root";
import {
  AutonomousTimePromptService,
  AUTONOMOUS_TIME_PROMPT_DEFAULT_PATH,
  resolveAutonomousTimePromptPath,
} from "./autonomous-time-prompt-service";

const testRoot = createIsolatedRuntimeRoot("openelinaro-autonomous-time-prompt-");
beforeEach(() => testRoot.setup());
afterEach(() => testRoot.teardown());

describe("AutonomousTimePromptService", () => {
  test("returns the fallback prompt when the configured file does not exist", () => {
    const service = new AutonomousTimePromptService();
    const snapshot = service.load({
      enabled: true,
      promptPath: AUTONOMOUS_TIME_PROMPT_DEFAULT_PATH,
    });

    expect(snapshot.text).toContain("You have autonomous time.");
    expect(snapshot.charCount).toBeGreaterThan(0);
    expect(snapshot.path).toBe(resolveAutonomousTimePromptPath(AUTONOMOUS_TIME_PROMPT_DEFAULT_PATH));
  });

  test("loads the authored prompt from the configured relative path", () => {
    const filePath = resolveAutonomousTimePromptPath("assistant_context/night-owl.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "Stay curious.");

    const service = new AutonomousTimePromptService();
    const snapshot = service.load({
      enabled: true,
      promptPath: "assistant_context/night-owl.md",
    });

    expect(snapshot.text).toBe("Stay curious.");
    expect(snapshot.path).toBe(filePath);
  });
});
