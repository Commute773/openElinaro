import { validateClaudeSetupToken } from "../../auth/claude";
import { saveClaudeSetupToken, saveZaiApiKey } from "../../auth/store";
import { telemetry } from "../../services/infrastructure/telemetry";

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
      telemetry.recordError(error, { operation: "auth-session.claudeSetup" });
      await send(error instanceof Error ? error.message : String(error));
    } finally {
      this.activeSessions.delete(userId);
      this.pendingPrompts.delete(userId);
    }
  }

  async startZaiApiKeyFlowForProfile(
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
          "Z.ai auth uses an API key.",
          "Paste your Z.ai API key here in DM.",
          "Reply `cancel` to abort.",
        ].join("\n"),
      );

      const key = await this.waitForPromptResponse(userId);
      const trimmed = key.trim();
      if (trimmed.length < 10) {
        await send("Z.ai API key rejected: too short.");
        return;
      }

      saveZaiApiKey(trimmed, profileId);
      await send(`Z.ai auth saved locally for profile ${profileId}.`);
    } catch (error) {
      telemetry.recordError(error, { operation: "auth-session.zaiApiKey" });
      await send(error instanceof Error ? error.message : String(error));
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
