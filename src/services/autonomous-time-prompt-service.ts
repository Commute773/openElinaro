import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "../config/runtime-config";
import { resolveUserDataPath } from "./runtime-root";
import { timestamp } from "../utils/timestamp";

export const AUTONOMOUS_TIME_PROMPT_DEFAULT_PATH = "assistant_context/autonomous-time.md";

const FALLBACK_AUTONOMOUS_TIME_PROMPT = [
  "You have autonomous time. No tasks, no user requests. This session is yours.",
  "",
  "You have access to all your tools. Nobody is waiting for output.",
  "Exit only when you're genuinely done, not because you ran out of input.",
].join("\n");

export interface AutonomousTimePromptSnapshot {
  text: string;
  path: string;
  loadedAt: string;
  charCount: number;
}

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
}
