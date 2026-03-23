import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getTestFixturesDir } from "../test/fixtures";

const repoRoot = process.cwd();
const TEST_ROOT_NAME = ".openelinarotest";
const MACHINE_TEST_ROOT = getTestFixturesDir();

let previousRootDirEnv: string | undefined;
let tempRoot = "";

let runtimeModule: typeof import("./runtime");
let authStoreModule: typeof import("../auth/store");

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

function copyFile(relativePath: string) {
  const source = path.join(MACHINE_TEST_ROOT, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  const destination = path.join(tempRoot, TEST_ROOT_NAME, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function resolveTestPath(...segments: string[]) {
  return path.join(tempRoot, TEST_ROOT_NAME, ...segments);
}

function writeProfileRegistry(providerId: "openai-codex" | "claude") {
  const defaultModelId = providerId === "openai-codex"
    ? "gpt-5.4"
    : "claude-opus-4-6-20260301";
  const toolSummarizerModelId = providerId === "openai-codex"
    ? "gpt-5.4"
    : "claude-haiku-4-5";
  fs.mkdirSync(resolveTestPath("profiles"), { recursive: true });
  fs.writeFileSync(
    resolveTestPath("profiles", "registry.json"),
    `${JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "root",
          name: "Root",
          roles: ["root"],
          memoryNamespace: "root",
          preferredProvider: providerId,
          defaultModelId,
          toolSummarizerProvider: providerId,
          toolSummarizerModelId,
          subagentPreferredProvider: providerId,
          subagentDefaultModelId: defaultModelId,
          maxSubagentDepth: 1,
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
}

function writeProjectRegistry() {
  fs.mkdirSync(resolveTestPath("projects"), { recursive: true });
  fs.writeFileSync(
    resolveTestPath("projects", "registry.json"),
    `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`,
    "utf8",
  );
}

function writeWorkspaceFixture() {
  fs.mkdirSync(resolveTestPath("memory", "documents", "root"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "README.md"), "# image e2e workspace\n", "utf8");
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify({ name: "openelinaro-image-e2e", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
}

// Minimal 1x1 red PNG (valid image the model can process)
const TINY_RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

async function main() {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-image-e2e-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;

  copyDirectory("system_prompt");
  copyMachineTestDirectory("system_prompt");
  copyMachineTestDirectory("assistant_context");
  copyFile("auth-store.json");
  writeProjectRegistry();
  writeWorkspaceFixture();

  authStoreModule = await importFresh("src/auth/store.ts");
  const providerId = authStoreModule.hasProviderAuth("openai-codex", "root")
    ? "openai-codex"
    : authStoreModule.hasProviderAuth("claude", "root")
      ? "claude"
      : null;
  if (!providerId) {
    throw new Error(
      `No root provider auth is configured in ${path.join(MACHINE_TEST_ROOT, "auth-store.json")}. Configure root auth before running the image e2e test.`,
    );
  }

  writeProfileRegistry(providerId);
  runtimeModule = await importFresh("src/app/runtime.ts");

  const app = new runtimeModule.OpenElinaroApp({ profileId: "root" });

  // Test 1: Image with base64 data and a sourceUrl (simulates Discord attachment path).
  // Before the fix, the sourceUrl caused the system to send the URL string as base64 data
  // to the Anthropic API, resulting in a 400 error.
  const conversationKey = `e2e:image:${Date.now()}`;
  const response = await app.handleRequest(
    {
      id: `e2e:image:${Date.now()}`,
      kind: "chat",
      conversationKey,
      text: "describe this image",
      chatContent: [
        { type: "text", text: "Describe what you see in this image in one short sentence." },
        {
          type: "image",
          data: TINY_RED_PNG_BASE64,
          mimeType: "image/png",
          sourceUrl: "https://cdn.discordapp.com/attachments/test/test/image.png",
        },
      ],
    },
    {
      onToolUse: async () => {},
    },
  );

  // The model should respond with something describing the image (a red pixel/square).
  // The key assertion: we got a non-empty response without a 400 error.
  assert(response.message.length > 0, "Expected a non-empty response from the model");

  // Verify the response acknowledges the image in some way (any of these words would indicate
  // the model saw the image rather than erroring)
  const lower = response.message.toLowerCase();
  const acknowledgesImage = lower.includes("image") || lower.includes("pixel")
    || lower.includes("red") || lower.includes("color") || lower.includes("small")
    || lower.includes("square") || lower.includes("dot") || lower.includes("solid")
    || lower.includes("single") || lower.includes("picture") || lower.includes("photo");
  assert(acknowledgesImage, `Expected model to acknowledge the image. Got: ${response.message}`);

  console.log("IMAGE_E2E_OK");
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
