/**
 * E2E runner: sends a plain-text DM through the Discord input path
 * (FakeDirectMessage → createDiscordEventHandlers → OpenElinaroApp → real model)
 * and asserts the agent produces a non-trivial response.
 *
 * Runs in a subprocess with an isolated OPENELINARO_ROOT_DIR so it never
 * touches production state.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ChannelType } from "discord.js";
import type { Message } from "discord.js";

const repoRoot = process.cwd();
const TEST_ROOT_NAME = ".openelinarotest";
const MACHINE_TEST_ROOT = path.join(os.homedir(), TEST_ROOT_NAME);
const PRODUCTION_ROOT = path.join(os.homedir(), ".openelinaro");

let previousRootDirEnv: string | undefined;
let tempRoot = "";

// Modules loaded with cache-busting so they pick up OPENELINARO_ROOT_DIR
let runtimeModule: typeof import("../../app/runtime");
let botModule: typeof import("./bot");
let authSessionManagerModule: typeof import("./auth-session-manager");
let authStoreModule: typeof import("../../auth/store");

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?runner=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function copyDirectory(relativePath: string) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, relativePath), { recursive: true });
}

function copyMachineTestDirectory(relativePath: string) {
  const source = path.join(MACHINE_TEST_ROOT, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, TEST_ROOT_NAME, relativePath), { recursive: true });
}

function findFixtureFile(relativePath: string) {
  for (const root of [MACHINE_TEST_ROOT, PRODUCTION_ROOT]) {
    const candidate = path.join(root, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findSecretStoreWithAuth() {
  for (const root of [MACHINE_TEST_ROOT, PRODUCTION_ROOT]) {
    const candidate = path.join(root, "secret-store.json");
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        profiles?: Record<string, { auth?: Record<string, unknown> }>;
      };
      const auth = parsed.profiles?.root?.auth;
      if (auth && Object.keys(auth).length > 0) {
        return candidate;
      }
    } catch {
      // skip unreadable files
    }
  }
  return null;
}

function copyMachineTestFile(relativePath: string) {
  const source = relativePath === "secret-store.json"
    ? findSecretStoreWithAuth()
    : findFixtureFile(relativePath);
  if (!source) {
    return;
  }
  const destination = path.join(tempRoot, TEST_ROOT_NAME, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function resolveTestPath(...segments: string[]) {
  return path.join(tempRoot, TEST_ROOT_NAME, ...segments);
}

function copyProdProfileAndModelState() {
  // Copy the REAL profile registry and model-state.json from production so the
  // test exercises the same provider, model, and settings as the deployed bot.
  for (const file of ["profiles/registry.json", "model-state.json"]) {
    const source = findFixtureFile(file);
    if (!source) {
      continue;
    }
    const destination = path.join(tempRoot, TEST_ROOT_NAME, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function writeProjectRegistry() {
  fs.mkdirSync(resolveTestPath("projects"), { recursive: true });
  fs.writeFileSync(
    resolveTestPath("projects", "registry.json"),
    `${JSON.stringify({ version: 1, projects: [], jobs: [] }, null, 2)}\n`,
    "utf8",
  );
}

function writeWorkspaceFixture() {
  fs.mkdirSync(resolveTestPath("memory", "documents", "root"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "README.md"), "# discord dm e2e workspace\n", "utf8");
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify({ name: "openelinaro-discord-dm-e2e", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// FakeDirectMessage — mimics a Discord DM without touching the gateway
// ---------------------------------------------------------------------------

class FakeDirectMessage {
  readonly replies: string[] = [];
  readonly replyPayloads: Array<{ content?: string; files?: unknown[] }> = [];
  readonly author = { id: "e2e-discord-user", bot: false };
  readonly channelId = "e2e-discord-dm";
  readonly attachments = new Map<string, never>();
  readonly channel: {
    type: ChannelType.DM;
    typingPulses: number;
    isSendable: () => boolean;
    sendTyping: () => Promise<void>;
    send: (payload: string | { content?: string; files?: unknown[] }) => Promise<void>;
  };

  constructor(readonly content: string) {
    this.channel = {
      type: ChannelType.DM,
      typingPulses: 0,
      isSendable: () => true,
      sendTyping: async () => {
        this.channel.typingPulses += 1;
      },
      send: async (payload: string | { content?: string; files?: unknown[] }) => {
        if (typeof payload === "string") {
          this.replies.push(payload);
          this.replyPayloads.push({ content: payload });
          return;
        }
        this.replies.push(payload.content ?? "");
        this.replyPayloads.push(payload);
      },
    };
  }

  async reply(payload: string | { content?: string; files?: unknown[] }) {
    if (typeof payload === "string") {
      this.replies.push(payload);
      this.replyPayloads.push({ content: payload });
      return;
    }
    this.replies.push(payload.content ?? "");
    this.replyPayloads.push(payload);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-discord-dm-e2e-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  // Clear USER_DATA_DIR so it doesn't leak the production path from the parent
  // shell — getUserDataRootDir() checks it before OPENELINARO_ROOT_DIR.
  delete process.env.OPENELINARO_USER_DATA_DIR;

  // Copy system prompts and auth fixtures
  copyDirectory("system_prompt");
  copyMachineTestDirectory("system_prompt");
  copyMachineTestDirectory("assistant_context");
  copyMachineTestFile("secret-store.json");
  writeProjectRegistry();
  writeWorkspaceFixture();

  // Copy the REAL production profile and model state so the test exercises the
  // exact same provider + model as the deployed bot.
  copyProdProfileAndModelState();

  // Verify auth is available
  authStoreModule = await importFresh("src/auth/store.ts");
  if (!authStoreModule.hasProviderAuth("claude", "root")) {
    throw new Error(
      "No root provider auth found. Ensure secret-store.json with valid credentials exists in ~/.openelinarotest/ or ~/.openelinaro/.",
    );
  }

  // Fresh-import runtime modules that read OPENELINARO_ROOT_DIR at load time
  runtimeModule = await importFresh("src/app/runtime.ts");
  botModule = await importFresh("src/integrations/discord/bot.ts");
  authSessionManagerModule = await importFresh("src/integrations/discord/auth-session-manager.ts");

  const app = new runtimeModule.OpenElinaroApp({ profileId: "root" });
  const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
  const handlers = botModule.createDiscordEventHandlers({
    app,
    authManager,
    profileId: "root",
  });

  // ---- Send a DM through the Discord input path ----
  const message = new FakeDirectMessage(
    "What is the capital of France? Reply with just the city name.",
  );

  await handlers.handleMessage(message as unknown as Message);

  // ---- Assertions ----
  const allReplies = message.replies.join("\n").toLowerCase();
  console.log(`[discord-dm-e2e] reply text: ${message.replies.join(" | ")}`);

  // The agent must have replied at least once
  assert(message.replies.length > 0, "Expected at least one reply from the agent");

  // The reply must contain "paris" — a fact the model cannot get wrong
  assert(
    allReplies.includes("paris"),
    `Expected response to contain "paris", got: ${message.replies.join(" | ")}`,
  );

  console.log("DISCORD_DM_E2E_OK");
}

main()
  .then(() => {
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    process.exit(1);
  });
