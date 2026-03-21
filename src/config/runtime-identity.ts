import { getRuntimeConfig } from "./runtime-config";

export const DEFAULT_ASSISTANT_DISPLAY_NAME = "OpenElinaro";
export function getAssistantDisplayName() {
  return getRuntimeConfig().core.assistant.displayName || DEFAULT_ASSISTANT_DISPLAY_NAME;
}

export function buildAssistantIdentityPromptContext() {
  const name = getAssistantDisplayName();
  return [
    "## Runtime Identity",
    `Configured assistant display name: ${name}.`,
    "Use this display name in user-facing status text and when referring to yourself conversationally, even if older prompt files mention another host-specific name.",
  ].join("\n");
}
