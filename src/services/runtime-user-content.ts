import path from "node:path";
import { getUserDataRootDir, resolveRuntimePath, resolveUserDataPath } from "./runtime-root";

export function getRepoSystemPromptRoot() {
  return resolveRuntimePath("system_prompt");
}

export function getUserSystemPromptRoot() {
  return resolveUserDataPath("system_prompt");
}

export function getAssistantContextRoot() {
  return resolveUserDataPath("assistant_context");
}

export function getUserAssistantDocsRoot() {
  return resolveUserDataPath("docs", "assistant");
}

export function resolveUserSystemPromptPath(...segments: string[]) {
  return path.join(getUserSystemPromptRoot(), ...segments);
}

export function resolveAssistantContextPath(...segments: string[]) {
  return path.join(getAssistantContextRoot(), ...segments);
}

export function resolveUserAssistantDocPath(...segments: string[]) {
  return path.join(getUserAssistantDocsRoot(), ...segments);
}

export function formatUserDataRelativePath(...segments: string[]) {
  return path.join(getUserDataRootDir(), ...segments);
}
