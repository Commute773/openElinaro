import { test, expect } from "bun:test";
import { isDiscordUserId, buildServiceTransitionCompletionMessage } from "./service-transition-notifier";

test("isDiscordUserId rejects conversation keys like 'main'", () => {
  expect(isDiscordUserId("main")).toBe(false);
});

test("isDiscordUserId accepts numeric Discord user IDs", () => {
  expect(isDiscordUserId("123456789012345678")).toBe(true);
});

test("buildServiceTransitionCompletionMessage formats update complete", () => {
  const msg = buildServiceTransitionCompletionMessage({
    action: "update",
    status: "completed",
    version: "2026.04.01.10",
  });
  expect(msg).toBe("update complete, new version: 2026.04.01.10");
});
