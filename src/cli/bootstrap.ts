import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ensureRuntimeConfigFile, getRuntimeConfig, saveRuntimeConfig, type RuntimeConfig } from "../config/runtime-config";
import { SecretStoreService } from "../services/secret-store-service";

function usage() {
  return [
    "Usage:",
    "  bun src/cli/bootstrap.ts",
    "",
    "Prompts for the Discord bot token and writes config.yaml plus the unified secret store.",
  ].join("\n");
}

async function promptHidden(question: string) {
  const rl = readline.createInterface({ input, output, terminal: true });
  const write = output.write.bind(output);
  output.write = () => true;
  try {
    const value = await rl.question(question);
    write("\n");
    return value.trim();
  } finally {
    output.write = write;
    rl.close();
  }
}

const command = process.argv[2];
if (command === "--help" || command === "-h") {
  console.log(usage());
  process.exit(0);
}

ensureRuntimeConfigFile();

const rl = readline.createInterface({ input, output, terminal: true });
const secrets = new SecretStoreService();

try {
  const token = await promptHidden("Discord bot token: ");
  if (!token) {
    throw new Error("Discord bot token is required.");
  }

  const assistantName = (await rl.question("Assistant display name [OpenElinaro]: ")).trim() || "OpenElinaro";
  const guildIdsRaw = (await rl.question("Discord guild ids (comma separated, optional): ")).trim();
  const guildIds = guildIdsRaw
    ? guildIdsRaw.split(",").map((value) => value.trim()).filter(Boolean)
    : [];

  secrets.saveSecret({
    name: "discord",
    fields: {
      botToken: token,
    },
  });

  const config = structuredClone(getRuntimeConfig()) as RuntimeConfig;
  config.core.assistant.displayName = assistantName;
  config.core.discord.botTokenSecretRef = "discord.botToken";
  config.core.discord.guildIds = guildIds;
  config.core.onboarding.bootstrapCompleted = true;
  saveRuntimeConfig(config);

  console.log("Bootstrap complete.");
  console.log("Next steps:");
  console.log("1. Start the service with `bun run start`.");
  console.log("2. If you plan to use browser, fetch, or local voice features, run `bun run setup:python` once.");
  console.log("3. In Discord, authenticate a provider and enable optional features with `feature_manage`.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  rl.close();
}
