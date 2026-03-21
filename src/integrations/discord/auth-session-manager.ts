import { loginOpenAICodex } from "@mariozechner/pi-ai/oauth";
import { validateClaudeSetupToken } from "../../auth/claude";
import { saveClaudeSetupToken, saveCodexCredentials } from "../../auth/store";

type SendMessage = (content: string) => Promise<void>;

type PendingPrompt = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

export class DiscordAuthSessionManager {
  private readonly pendingPrompts = new Map<string, PendingPrompt>();
  private readonly activeSessions = new Set<string>();

  consumePromptResponse(userId: string, content: string): boolean {
    const pending = this.pendingPrompts.get(userId);
    if (!pending) {
      return false;
    }

    this.pendingPrompts.delete(userId);
    if (content.trim().toLowerCase() === "cancel") {
      pending.reject(new Error("Cancelled by user."));
      return true;
    }

    pending.resolve(content);
    return true;
  }

  async startClaudeSetupTokenFlow(userId: string, send: SendMessage): Promise<void> {
    return this.startClaudeSetupTokenFlowForProfile("root", userId, send);
  }

  async startClaudeSetupTokenFlowForProfile(
    profileId: string,
    userId: string,
    send: SendMessage,
  ): Promise<void> {
    if (this.activeSessions.has(userId)) {
      await send("An auth flow is already active. Reply `cancel` to stop it first.");
      return;
    }

    this.activeSessions.add(userId);
    try {
      await send(
        [
          "Claude auth uses a setup-token flow.",
          "1. Run `claude setup-token` on your machine.",
          "2. Paste the full token here in DM.",
          "Reply `cancel` to abort.",
        ].join("\n"),
      );

      const token = await this.waitForPromptResponse(userId);
      const validationError = validateClaudeSetupToken(token);
      if (validationError) {
        await send(`Claude token rejected: ${validationError}`);
        return;
      }

      saveClaudeSetupToken(token.trim(), profileId);
      await send(`Claude auth saved locally for profile ${profileId}.`);
    } catch (error) {
      await send(error instanceof Error ? error.message : String(error));
    } finally {
      this.activeSessions.delete(userId);
      this.pendingPrompts.delete(userId);
    }
  }

  async startCodexOAuthFlow(userId: string, send: SendMessage): Promise<void> {
    return this.startCodexOAuthFlowForProfile("root", userId, send);
  }

  async startCodexOAuthFlowForProfile(
    profileId: string,
    userId: string,
    send: SendMessage,
  ): Promise<void> {
    if (this.activeSessions.has(userId)) {
      await send("An auth flow is already active. Reply `cancel` to stop it first.");
      return;
    }

    this.activeSessions.add(userId);
    try {
      let hasPromptedForManualInput = false;
      const requestManualInput = async () => {
        if (!hasPromptedForManualInput) {
          hasPromptedForManualInput = true;
          await send("Paste the authorization code (or full redirect URL):");
        }
        return await this.waitForPromptResponse(userId);
      };

      const credentials = await loginOpenAICodex({
        onAuth: async ({ url, instructions }) => {
          await send(
            [
              "Open the Codex sign-in URL in your browser:",
              url,
              instructions ?? "After sign-in, paste the redirect URL or requested code back here.",
              "Reply `cancel` to abort.",
            ].join("\n"),
          );
        },
        onManualCodeInput: requestManualInput,
        onPrompt: async (prompt) => {
          if (!hasPromptedForManualInput) {
            await send(prompt.message);
          }
          return await requestManualInput();
        },
        onProgress: async (message) => {
          await send(`Codex auth: ${message}`);
        },
      });

      saveCodexCredentials(credentials, profileId);
      await send(`Codex auth saved locally for profile ${profileId}.`);
    } catch (error) {
      await send(`Codex auth failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.activeSessions.delete(userId);
      this.pendingPrompts.delete(userId);
    }
  }

  private waitForPromptResponse(userId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pendingPrompts.set(userId, { resolve, reject });
    });
  }
}
