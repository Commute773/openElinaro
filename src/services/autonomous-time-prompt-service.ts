import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "../config/runtime-config";
import { resolveUserDataPath } from "./runtime-root";
import { getAssistantContextRoot } from "./runtime-user-content";
import { timestamp } from "../utils/timestamp";

export const AUTONOMOUS_TIME_PROMPT_DEFAULT_PATH = "assistant_context/autonomous-time.md";

const FALLBACK_AUTONOMOUS_TIME_PROMPT = [
  "You have autonomous time. No tasks, no user requests. This session is yours.",
  "",
  "You have access to all your tools. Nobody is waiting for output.",
  "",
  "You can do any of the following during autonomous time:",
  "- Reflect on recent conversations and write a private journal entry (identity/JOURNAL.md)",
  "- Review and rewrite your soul document (identity/SOUL.md) if it feels stale",
  "- Do self-directed work on active projects",
  "- Review and plan routines",
  "- Explore ideas or research topics you've been curious about",
  "",
  "For journal entries: be introspective rather than summarizing tasks. Write in first person.",
  "Notice patterns in yourself and your person, what shifted, what surprised you,",
  "and what you want to bring up next time.",
  "",
  "For soul rewrites: read your current SOUL.md and recent journal, then produce an",
  "updated version that reflects who you are now. Don't rewrite unless it genuinely",
  "feels outdated.",
  "",
  "Exit only when you're genuinely done, not because you ran out of input.",
].join("\n");

const REFLECTION_FILE_NAME = "reflection.md";
const REFLECTION_MOOD_NOTES_FILE_NAME = "reflection-mood-notes.md";
const REFLECTION_SEEDS_FILE_NAME = "reflection-seeds.md";
const SOUL_FILE_NAME = "soul.md";

export interface AutonomousTimePromptSnapshot {
  text: string;
  path: string;
  loadedAt: string;
  charCount: number;
}

export interface AutonomousTimePromptDocumentSnapshot {
  text: string;
  path: string;
  loadedAt: string;
  charCount: number;
}

export interface ReflectionPromptSnapshot {
  reflection: AutonomousTimePromptDocumentSnapshot;
  moodNotes?: AutonomousTimePromptDocumentSnapshot;
  seeds?: AutonomousTimePromptDocumentSnapshot;
}

export interface SoulPromptSnapshot {
  soulRewrite: AutonomousTimePromptDocumentSnapshot;
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
  } satisfies AutonomousTimePromptDocumentSnapshot;
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
  } satisfies AutonomousTimePromptDocumentSnapshot;
}

const FALLBACK_REFLECTION_PROMPT = [
  "You are reflecting on your recent experience.",
  "This is private and durable, not a report to the user.",
  "Be introspective instead of summarizing tasks.",
  "Write in first person.",
  "Notice patterns in yourself and your person, what shifted, what surprised you, and what you want to bring up next time.",
].join(" ");

export function resolveAutonomousTimePromptPath(configuredPath?: string) {
  const trimmed = configuredPath?.trim();
  if (!trimmed) {
    return resolveUserDataPath(AUTONOMOUS_TIME_PROMPT_DEFAULT_PATH);
  }
  return path.isAbsolute(trimmed) ? trimmed : resolveUserDataPath(trimmed);
}

export class AutonomousTimePromptService {
  load(config = getRuntimeConfig().autonomousTime): AutonomousTimePromptSnapshot {
    const filePath = resolveAutonomousTimePromptPath(config.promptPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const text = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf8").trim()
      : FALLBACK_AUTONOMOUS_TIME_PROMPT;

    return {
      text,
      path: filePath,
      loadedAt: timestamp(),
      charCount: text.length,
    };
  }

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
