import { telemetry } from "./services/telemetry";
import { startHttpServer } from "./integrations/http/server";
import { startDiscordBot } from "./integrations/discord/bot";
import { startLocalVoiceSidecarRuntime } from "./services/local-voice-sidecar-runtime";

process.on("unhandledRejection", (reason) => {
  telemetry.recordError(reason, {
    eventName: "process.unhandled_rejection",
  });
});

process.on("uncaughtException", (error) => {
  telemetry.recordError(error, {
    eventName: "process.uncaught_exception",
  });
});

startHttpServer();
await startDiscordBot();

const localVoiceSidecars = await startLocalVoiceSidecarRuntime();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void localVoiceSidecars.stop();
  });
}
