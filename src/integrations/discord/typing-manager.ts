import type { Message } from "discord.js";
import { DISCORD_TYPING_REFRESH_MS } from "../../config/service-constants";
import { telemetry } from "../../services/infrastructure/telemetry";

const discordTelemetry = telemetry.child({ component: "discord" });

export function createConversationTypingTracker() {
  const states = new Map<string, {
    channel?: {
      sendTyping: () => Promise<unknown>;
    };
    active: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }>();

  const scheduleNextPulse = (conversationKey: string, state: {
    channel?: { sendTyping: () => Promise<unknown> };
    active: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }) => {
    state.timer = setTimeout(() => {
      void pulse(conversationKey);
    }, DISCORD_TYPING_REFRESH_MS);
  };

  const pulse = async (conversationKey: string) => {
    const state = states.get(conversationKey);
    if (!state?.active || !state.channel) {
      return;
    }

    try {
      await state.channel.sendTyping();
    } catch (error) {
      discordTelemetry.event(
        "discord.typing_indicator.error",
        {
          conversationKey,
          error: error instanceof Error ? error.message : String(error),
        },
        { level: "debug", outcome: "error" },
      );
    }

    if (state.active) {
      scheduleNextPulse(conversationKey, state);
    }
  };

  return {
    noteChannel(conversationKey: string, message: Message) {
      if (!("sendTyping" in message.channel) || typeof message.channel.sendTyping !== "function") {
        return;
      }

      const existing = states.get(conversationKey);
      if (existing) {
        existing.channel = message.channel;
        if (existing.active && !existing.timer) {
          void pulse(conversationKey);
        }
        return;
      }

      const state: {
        channel?: {
          sendTyping: () => Promise<unknown>;
        };
        active: boolean;
        timer?: ReturnType<typeof setTimeout>;
      } = {
        channel: message.channel,
        active: false,
      };
      states.set(conversationKey, state);
      if (state.active && !state.timer) {
        void pulse(conversationKey);
      }
    },
    async setActive(conversationKey: string, active: boolean) {
      const state = states.get(conversationKey) ?? {
        active: false,
      };
      states.set(conversationKey, state);

      if (state.active === active) {
        return;
      }

      state.active = active;
      if (!active) {
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
        return;
      }

      if (!state.channel) {
        return;
      }

      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      await pulse(conversationKey);
    },
  };
}

export async function withTypingIndicator<T>(message: Message, run: () => Promise<T>) {
  if (!("sendTyping" in message.channel)) {
    return run();
  }

  let isActive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNextPulse = () => {
    timer = setTimeout(() => {
      void pulseTyping();
    }, DISCORD_TYPING_REFRESH_MS);
  };

  const pulseTyping = async () => {
    if (!isActive) {
      return;
    }

    try {
      if ("sendTyping" in message.channel && typeof message.channel.sendTyping === "function") {
        await message.channel.sendTyping();
      }
    } catch (error) {
      discordTelemetry.event(
        "discord.typing_indicator.error",
        {
          userId: message.author.id,
          channelId: message.channelId,
          error: error instanceof Error ? error.message : String(error),
        },
        { level: "debug", outcome: "error" },
      );
      return;
    }

    if (isActive) {
      scheduleNextPulse();
    }
  };

  await pulseTyping();

  try {
    return await run();
  } finally {
    isActive = false;
    if (timer) {
      clearTimeout(timer);
    }
  }
}
