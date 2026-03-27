import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIsolatedRuntimeRoot } from "../test/isolated-runtime-root";
import { ReflectionPromptService } from "./reflection-prompt-service";
import { resolveAssistantContextPath } from "./runtime-user-content";

const testRoot = createIsolatedRuntimeRoot("openelinaro-reflection-prompt-");
beforeEach(() => testRoot.setup());
afterEach(() => testRoot.teardown());

describe("ReflectionPromptService", () => {
  test("returns fallback reflection prompt when no files exist", () => {
    const service = new ReflectionPromptService();
    const snapshot = service.loadReflectionPrompt();

    expect(snapshot.reflection.text).toContain("reflecting on your recent experience");
    expect(snapshot.reflection.charCount).toBeGreaterThan(0);
    expect(snapshot.moodNotes).toBeUndefined();
    expect(snapshot.seeds).toBeUndefined();
  });

  test("loads authored reflection prompt files", () => {
    const contextRoot = resolveAssistantContextPath();
    fs.mkdirSync(contextRoot, { recursive: true });
    fs.writeFileSync(resolveAssistantContextPath("reflection.md"), "Be honest with yourself.");
    fs.writeFileSync(resolveAssistantContextPath("reflection-mood-notes.md"), "Use one word.");
    fs.writeFileSync(resolveAssistantContextPath("reflection-seeds.md"), "Carry forward what matters.");

    const service = new ReflectionPromptService();
    const snapshot = service.loadReflectionPrompt();

    expect(snapshot.reflection.text).toBe("Be honest with yourself.");
    expect(snapshot.moodNotes?.text).toBe("Use one word.");
    expect(snapshot.seeds?.text).toBe("Carry forward what matters.");
  });

  test("returns null for soul rewrite prompt when soul.md does not exist", () => {
    const service = new ReflectionPromptService();
    const result = service.loadSoulRewritePrompt();
    expect(result).toBeNull();
  });

  test("returns soul rewrite prompt when soul.md exists", () => {
    const contextRoot = resolveAssistantContextPath();
    fs.mkdirSync(contextRoot, { recursive: true });
    fs.writeFileSync(resolveAssistantContextPath("soul.md"), "You are thoughtful and calm.");

    const service = new ReflectionPromptService();
    const result = service.loadSoulRewritePrompt();

    expect(result).not.toBeNull();
    expect(result!.soulRewrite.text).toBe("You are thoughtful and calm.");
  });

  test("buildReflectionSystemPrompt combines all documents with JSON instructions", () => {
    const contextRoot = resolveAssistantContextPath();
    fs.mkdirSync(contextRoot, { recursive: true });
    fs.writeFileSync(resolveAssistantContextPath("reflection.md"), "Write honestly.");
    fs.writeFileSync(resolveAssistantContextPath("reflection-mood-notes.md"), "Use one sharp word.");

    const service = new ReflectionPromptService();
    const { text, snapshot } = service.buildReflectionSystemPrompt();

    expect(text).toContain("Write honestly.");
    expect(text).toContain("Use one sharp word.");
    expect(text).toContain("Return strict JSON with keys body, mood, bring_up_next_time.");
    expect(snapshot.reflection.text).toBe("Write honestly.");
    expect(snapshot.moodNotes?.text).toBe("Use one sharp word.");
    expect(snapshot.seeds).toBeUndefined();
  });

  test("buildReflectionSystemPrompt uses fallback when no files exist", () => {
    const service = new ReflectionPromptService();
    const { text } = service.buildReflectionSystemPrompt();

    expect(text).toContain("reflecting on your recent experience");
    expect(text).toContain("Return strict JSON with keys body, mood, bring_up_next_time.");
  });
});
