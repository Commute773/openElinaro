import { describe, expect, test } from "bun:test";
import { HeartbeatService } from "./heartbeat-service";

describe("HeartbeatService.normalizeAssistantReply", () => {
  const svc = new HeartbeatService();

  // --- Suppressed responses ---

  test("suppresses undefined", () => {
    expect(svc.normalizeAssistantReply(undefined)).toBeUndefined();
  });

  test("suppresses empty string", () => {
    expect(svc.normalizeAssistantReply("")).toBeUndefined();
  });

  test("suppresses whitespace-only", () => {
    expect(svc.normalizeAssistantReply("   \n  \n  ")).toBeUndefined();
  });

  test("suppresses exact HEARTBEAT_OK", () => {
    expect(svc.normalizeAssistantReply("HEARTBEAT_OK")).toBeUndefined();
  });

  test("suppresses lowercase heartbeat_ok", () => {
    expect(svc.normalizeAssistantReply("heartbeat_ok")).toBeUndefined();
  });

  test("suppresses HEARTBEAT OK with space", () => {
    expect(svc.normalizeAssistantReply("HEARTBEAT OK")).toBeUndefined();
  });

  test("suppresses with trailing period", () => {
    expect(svc.normalizeAssistantReply("HEARTBEAT_OK.")).toBeUndefined();
  });

  test("suppresses with trailing exclamation", () => {
    expect(svc.normalizeAssistantReply("heartbeat_ok!")).toBeUndefined();
  });

  test("suppresses HEARTBEAT_OK with leading/trailing whitespace", () => {
    expect(svc.normalizeAssistantReply("  HEARTBEAT_OK  ")).toBeUndefined();
  });

  test("suppresses multiline with HEARTBEAT_OK on its own line", () => {
    expect(svc.normalizeAssistantReply(
      "I checked everything.\nHEARTBEAT_OK",
    )).toBeUndefined();
  });

  test("suppresses HEARTBEAT_OK with preceding context lines", () => {
    expect(svc.normalizeAssistantReply(
      "All routines checked, no action needed.\n\nHEARTBEAT_OK",
    )).toBeUndefined();
  });

  // --- Markdown-formatted HEARTBEAT_OK variants ---

  test("suppresses backtick-wrapped HEARTBEAT_OK", () => {
    expect(svc.normalizeAssistantReply("`HEARTBEAT_OK`")).toBeUndefined();
  });

  test("suppresses bold HEARTBEAT_OK", () => {
    expect(svc.normalizeAssistantReply("**HEARTBEAT_OK**")).toBeUndefined();
  });

  test("suppresses italic HEARTBEAT_OK", () => {
    expect(svc.normalizeAssistantReply("*HEARTBEAT_OK*")).toBeUndefined();
  });

  test("suppresses HEARTBEAT_OK after markdown heading", () => {
    expect(svc.normalizeAssistantReply("# HEARTBEAT_OK")).toBeUndefined();
  });

  test("suppresses HEARTBEAT_OK in blockquote", () => {
    expect(svc.normalizeAssistantReply("> HEARTBEAT_OK")).toBeUndefined();
  });

  test("suppresses HEARTBEAT_OK as list item", () => {
    expect(svc.normalizeAssistantReply("- HEARTBEAT_OK")).toBeUndefined();
  });

  // --- Empty response fallback strings ---

  test("suppresses 'The assistant responded without text output.'", () => {
    expect(svc.normalizeAssistantReply(
      "The assistant responded without text output.",
    )).toBeUndefined();
  });

  test("suppresses 'The assistant did not return a reply.'", () => {
    expect(svc.normalizeAssistantReply(
      "The assistant did not return a reply.",
    )).toBeUndefined();
  });

  // --- Non-suppressed responses (should pass through) ---

  test("passes through actionable reminder", () => {
    const msg = "You have a meeting in 15 minutes.";
    expect(svc.normalizeAssistantReply(msg)).toBe(msg);
  });

  test("passes through user-facing message", () => {
    const msg = "Good morning! Here's your daily summary:\n- 3 unread emails\n- 1 overdue task";
    expect(svc.normalizeAssistantReply(msg)).toBe(msg);
  });
});
