import type { LanguageModelV3 } from "@ai-sdk/provider";

export interface ProviderConnector extends LanguageModelV3 {
  readonly providerId: string;
  setThinkingCallback?: (
    sessionId: string,
    callback?: (message: string) => Promise<void> | void,
  ) => void;
}
