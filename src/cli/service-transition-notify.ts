import {
  buildServiceTransitionCompletionMessage,
  sendDiscordDirectMessage,
} from "../services/service-transition-notifier";

function usage() {
  return "usage: bun src/cli/service-transition-notify.ts <update|rollback> <completed|failed> <discord-user-id> [version]";
}

const action = process.argv[2];
const status = process.argv[3];
const userId = process.argv[4];
const version = process.argv[5];

if ((action !== "update" && action !== "rollback") || (status !== "completed" && status !== "failed") || !userId?.trim()) {
  console.error(usage());
  process.exit(1);
}

const message = buildServiceTransitionCompletionMessage({
  action,
  status,
  version,
});

if (!message) {
  process.exit(0);
}

try {
  await sendDiscordDirectMessage({ userId, message });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
