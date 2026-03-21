import { describe, expect, test } from "bun:test";
import {
  buildServiceTransitionCompletionMessage,
  isDiscordUserId,
} from "./service-transition-notifier";

describe("service transition notifier", () => {
  test("builds the update completion message", () => {
    expect(buildServiceTransitionCompletionMessage({
      action: "update",
      status: "completed",
      version: "2026.03.20.1",
    })).toBe("update complete, new version: 2026.03.20.1");
  });

  test("builds the update failure message", () => {
    expect(buildServiceTransitionCompletionMessage({
      action: "update",
      status: "failed",
      version: "2026.03.20.1",
    })).toBe("update failed. the previous version should still be running.");
  });

  test("ignores unsupported actions", () => {
    expect(buildServiceTransitionCompletionMessage({
      action: "rollback",
      status: "completed",
      version: "2026.03.20.1",
    })).toBeNull();
  });

  test("validates discord user ids conservatively", () => {
    expect(isDiscordUserId("123456789012345678")).toBe(true);
    expect(isDiscordUserId("discord-user")).toBe(false);
    expect(isDiscordUserId("")).toBe(false);
  });
});
