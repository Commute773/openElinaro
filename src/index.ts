import { telemetry } from "./services/telemetry";
import { startHttpServer } from "./integrations/http/server";
import { startDiscordBot } from "./integrations/discord/bot";
import { startLocalVoiceSidecarRuntime } from "./services/local-voice-sidecar-runtime";

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
  telemetry.recordError(reason, {
    eventName: "process.unhandled_rejection",
  });
});

process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught exception:", error);
  telemetry.recordError(error, {
    eventName: "process.uncaught_exception",
  });
  process.exit(1);
});

startHttpServer();
try {
  await startDiscordBot();
} catch (error) {
  console.error("[FATAL] Discord bot startup failed:", error);
  telemetry.recordError(error, {
    eventName: "process.startup_failed",
  });
  process.exit(1);
}

const localVoiceSidecars = await startLocalVoiceSidecarRuntime();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void localVoiceSidecars.stop();
  });
}
