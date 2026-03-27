import fs from "node:fs";
import path from "node:path";
import { getAssistantContextRoot } from "./runtime-user-content";
import { timestamp } from "../utils/timestamp";

const REFLECTION_FILE_NAME = "reflection.md";
const REFLECTION_MOOD_NOTES_FILE_NAME = "reflection-mood-notes.md";
const REFLECTION_SEEDS_FILE_NAME = "reflection-seeds.md";
const SOUL_FILE_NAME = "soul.md";

const FALLBACK_REFLECTION_PROMPT = [
  "You are reflecting on your recent experience.",
  "This is private and durable, not a report to the user.",
  "Be introspective instead of summarizing tasks.",
  "Write in first person.",
  "Notice patterns in yourself and your person, what shifted, what surprised you, and what you want to bring up next time.",
].join(" ");

export interface ReflectionPromptDocumentSnapshot {
  text: string;
  path: string;
  loadedAt: string;
  charCount: number;
}

export interface ReflectionPromptSnapshot {
  reflection: ReflectionPromptDocumentSnapshot;
  moodNotes?: ReflectionPromptDocumentSnapshot;
  seeds?: ReflectionPromptDocumentSnapshot;
}

export interface SoulPromptSnapshot {
  soulRewrite: ReflectionPromptDocumentSnapshot;
}

function loadOptionalDocument(fileName: string) {
  const assistantContextRoot = getAssistantContextRoot();
  const filePath = path.join(assistantContextRoot, fileName);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const text = fs.readFileSync(filePath, "utf8").trim();
  return {
    text,
    path: filePath,
    loadedAt: timestamp(),
    charCount: text.length,
  } satisfies ReflectionPromptDocumentSnapshot;
}

function loadRequiredDocument(fileName: string, fallbackText: string) {
  const assistantContextRoot = getAssistantContextRoot();
  fs.mkdirSync(assistantContextRoot, { recursive: true });
  const filePath = path.join(assistantContextRoot, fileName);
  const text = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8").trim()
    : fallbackText;
  return {
    text,
    path: filePath,
    loadedAt: timestamp(),
    charCount: text.length,
  } satisfies ReflectionPromptDocumentSnapshot;
}

export class ReflectionPromptService {
  loadReflectionPrompt(): ReflectionPromptSnapshot {
    return {
      reflection: loadRequiredDocument(REFLECTION_FILE_NAME, FALLBACK_REFLECTION_PROMPT),
      moodNotes: loadOptionalDocument(REFLECTION_MOOD_NOTES_FILE_NAME),
      seeds: loadOptionalDocument(REFLECTION_SEEDS_FILE_NAME),
    };
  }

  loadSoulRewritePrompt(): SoulPromptSnapshot | null {
    const soulRewrite = loadOptionalDocument(SOUL_FILE_NAME);
    if (!soulRewrite) {
      return null;
    }
    return { soulRewrite };
  }

  buildReflectionSystemPrompt() {
    const snapshot = this.loadReflectionPrompt();
    return {
      snapshot,
      text: [
        snapshot.reflection.text,
        snapshot.moodNotes?.text,
        snapshot.seeds?.text,
        [
          "Return strict JSON with keys body, mood, bring_up_next_time.",
          "body must be honest first-person reflection, usually 3-10 sentences.",
          "mood must be a short one- or two-word emotional tag.",
          "bring_up_next_time must be a concrete follow-up seed or an empty string.",
        ].join(" "),
      ].filter(Boolean).join("\n\n"),
    };
  }
}

export {
  REFLECTION_FILE_NAME,
  REFLECTION_MOOD_NOTES_FILE_NAME,
  REFLECTION_SEEDS_FILE_NAME,
  SOUL_FILE_NAME,
};
