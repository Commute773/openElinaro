import assert from "node:assert/strict";
import { exec, execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const TEST_ROOT_NAME = ".openelinarotest";
const PRODUCTION_USER_DATA = path.join(os.homedir(), ".openelinaro");

// Test Vonage infrastructure (created via API — see docs)
const TEST_VONAGE_APP_ID = "80bd7801-b8e9-4cba-9ac0-37db882f497b";
const TEST_TARGET_NUMBER = "12044102291";
const MAIN_VONAGE_APP_ID = "57a586c8-d96f-4199-b793-47dd5150023f";
const MAIN_FROM_NUMBER = "14382665181";
const VONAGE_API_KEY = process.env.VONAGE_API_KEY;
const VONAGE_API_SECRET = process.env.VONAGE_API_SECRET;

const SERVER_PORT = 3456;

let previousRootDirEnv: string | undefined;
let tempRoot = "";
let cloudflaredProcess: ChildProcess | null = null;
let serverInstance: { stop(): void } | null = null;

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?runner=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function resolveTestPath(...segments: string[]) {
  return path.join(tempRoot, TEST_ROOT_NAME, ...segments);
}

function copyProductionSecrets() {
  const prodStorePath = path.join(PRODUCTION_USER_DATA, "secret-store.json");
  if (!fs.existsSync(prodStorePath)) {
    throw new Error(`Production secret store not found at ${prodStorePath}`);
  }
  const prodStore = JSON.parse(fs.readFileSync(prodStorePath, "utf8")) as {
    version: number;
    profiles: Record<string, { secrets: Record<string, unknown>; auth: Record<string, unknown> }>;
  };

  const rootSecrets = prodStore.profiles?.root?.secrets ?? {};
  const vonageSecret = rootSecrets.vonage;
  const geminiSecret = rootSecrets.gemini;

  if (!vonageSecret) {
    throw new Error("Vonage secret not found in production secret store (root profile).");
  }
  if (!geminiSecret) {
    throw new Error("Gemini secret not found in production secret store (root profile).");
  }

  const minimalStore = {
    version: 2,
    profiles: {
      root: {
        secrets: { vonage: vonageSecret, gemini: geminiSecret },
        auth: {},
      },
    },
  };

  const testStorePath = resolveTestPath("secret-store.json");
  fs.mkdirSync(path.dirname(testStorePath), { recursive: true });
  fs.writeFileSync(testStorePath, JSON.stringify(minimalStore, null, 2), { mode: 0o600 });
}

function writeTestConfig(publicBaseUrl: string) {
  const yamlContent = [
    "core:",
    "  http:",
    "    host: 0.0.0.0",
    `    port: ${SERVER_PORT}`,
    "communications:",
    "  enabled: true",
    `  publicBaseUrl: "${publicBaseUrl}"`,
    "  vonage:",
    `    applicationId: "${MAIN_VONAGE_APP_ID}"`,
    "    privateKeySecretRef: vonage.private_key",
    "    signatureSecretRef: vonage.signature_secret",
    `    defaultFromNumber: "${MAIN_FROM_NUMBER}"`,
    '    defaultMessageFrom: ""',
    "    defaultMessageChannel: sms",
    '    voiceRegion: ""',
    "    voiceApiBaseUrl: https://api.nexmo.com",
    "    messagesApiBaseUrl: https://api.nexmo.com",
    "    webhookBasePath: /webhooks/vonage",
    "    secretProfileId: root",
    '    voiceAnswerText: "Test server online."',
    "  geminiLive:",
    "    apiKeySecretRef: gemini.apiKey",
    "    secretProfileId: root",
    "    model: gemini-2.5-flash-native-audio-preview-12-2025",
    '    voiceName: ""',
    "    prefixPaddingMs: 20",
    "    silenceDurationMs: 100",
  ].join("\n");

  const configPath = resolveTestPath("config.yaml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${yamlContent}\n`, "utf8");
}

async function startCloudflaredTunnel(port: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Cloudflared tunnel did not produce a URL within 30 seconds")),
      30_000,
    );

    const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    cloudflaredProcess = proc;

    let stderrBuffer = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      const match = stderrBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Cloudflared exited with code ${code} before producing a URL`));
    });
  });
}

function updateTestVonageAppAnswerUrl(tunnelUrl: string) {
  if (!VONAGE_API_KEY || !VONAGE_API_SECRET) {
    throw new Error("VONAGE_API_KEY and VONAGE_API_SECRET environment variables are required");
  }

  const auth = Buffer.from(`${VONAGE_API_KEY}:${VONAGE_API_SECRET}`).toString("base64");
  const body = JSON.stringify({
    name: "Elinaro E2E Test Target",
    capabilities: {
      voice: {
        webhooks: {
          answer_url: {
            address: `${tunnelUrl}/webhooks/vonage/voice/test-answer`,
            http_method: "GET",
          },
          event_url: {
            address: `${tunnelUrl}/webhooks/vonage/voice/event`,
            http_method: "GET",
          },
        },
      },
    },
  });

  execSync(
    `curl -sf -X PUT "https://api.nexmo.com/v2/applications/${TEST_VONAGE_APP_ID}" `
      + `-H "Authorization: Basic ${auth}" `
      + `-H "Content-Type: application/json" `
      + `-d '${body.replace(/'/g, "'\\''")}'`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

type SessionRecord = {
  id: string;
  status: string;
  transcriptLogPath: string;
  error: string | null;
};

type PhoneService = {
  makePhoneCall(input: { to: string; from?: string; instructions: string }): Promise<SessionRecord>;
  getSession(id: string): SessionRecord | null;
};

async function waitForSession(
  service: PhoneService,
  sessionId: string,
  timeoutMs = 120_000,
): Promise<SessionRecord> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = service.getSession(sessionId);
    if (session && (session.status === "completed" || session.status === "failed")) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const finalSession = service.getSession(sessionId);
  throw new Error(
    `Session ${sessionId} did not complete within ${timeoutMs}ms. Status: ${finalSession?.status ?? "unknown"}`,
  );
}

async function main() {
  console.log("PHONE_CALL_E2E: starting...");

  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-phone-e2e-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  console.log(`PHONE_CALL_E2E: temp root = ${tempRoot}`);

  copyProductionSecrets();

  // Start cloudflared tunnel (need URL before writing config)
  console.log("PHONE_CALL_E2E: starting cloudflared tunnel...");
  const tunnelUrl = await startCloudflaredTunnel(SERVER_PORT);
  console.log(`PHONE_CALL_E2E: tunnel URL = ${tunnelUrl}`);

  writeTestConfig(tunnelUrl);

  // Point the test Vonage app's answer webhook at the tunnel
  console.log("PHONE_CALL_E2E: updating test Vonage app answer_url...");
  updateTestVonageAppAnswerUrl(tunnelUrl);

  // Import modules fresh so they pick up the test config and secrets
  const serverModule = await importFresh<typeof import("../integrations/http/server")>(
    "src/integrations/http/server.ts",
  );
  const vonageModule = await importFresh<typeof import("../services/vonage-service")>(
    "src/services/vonage-service.ts",
  );
  const geminiModule = await importFresh<typeof import("../services/gemini-live-phone-service")>(
    "src/services/gemini-live-phone-service.ts",
  );

  const vonage = new vonageModule.VonageService();
  const geminiLivePhone = new geminiModule.GeminiLivePhoneService({ vonage }) as PhoneService;

  console.log(`PHONE_CALL_E2E: starting HTTP server on port ${SERVER_PORT}...`);
  serverInstance = serverModule.startHttpServer(
    vonage,
    geminiLivePhone as InstanceType<typeof geminiModule.GeminiLivePhoneService>,
  );

  // Verify the server is reachable locally (use fetch, not execSync which blocks the event loop)
  console.log("PHONE_CALL_E2E: verifying local server...");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const localResponse = await fetch(`http://localhost:${SERVER_PORT}/healthz`);
  assert.equal(localResponse.status, 200, "Local server /healthz should return 200");
  console.log(`PHONE_CALL_E2E: local server OK`);

  // Verify tunnel connectivity.
  // Bun's fetch cannot resolve trycloudflare.com, so use Bun.spawn(curl) which is non-blocking.
  console.log("PHONE_CALL_E2E: verifying tunnel connectivity...");
  let tunnelVerified = false;
  // cloudflare quick tunnels can take 10-30s for DNS to propagate
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    try {
      const { stdout, exitCode } = await new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
        exec(
          `curl -sf --max-time 10 "${tunnelUrl}/webhooks/vonage/voice/test-answer"`,
          { encoding: "utf8" },
          (error, stdout) => {
            resolve({ stdout: stdout ?? "", exitCode: error ? (error as { code?: number }).code ?? 1 : 0 });
          },
        );
      });
      if (exitCode === 0 && stdout.trim()) {
        const parsed = JSON.parse(stdout);
        if (Array.isArray(parsed) && parsed.length > 0) {
          tunnelVerified = true;
          console.log(`PHONE_CALL_E2E: tunnel verified on attempt ${attempt + 1}`);
          break;
        }
      }
    } catch {
      // not ready yet
    }
    console.log(`PHONE_CALL_E2E: tunnel attempt ${attempt + 1} not ready yet`);
  }
  if (!tunnelVerified) {
    throw new Error("Could not verify tunnel connectivity after 15 attempts");
  }

  // Make the phone call
  console.log(`PHONE_CALL_E2E: calling test number ${TEST_TARGET_NUMBER}...`);
  const session = await geminiLivePhone.makePhoneCall({
    to: TEST_TARGET_NUMBER,
    instructions:
      "Listen carefully to what the caller says. When they finish speaking, briefly confirm what you heard then say goodbye.",
  });
  console.log(`PHONE_CALL_E2E: session ${session.id} created, status: ${session.status}`);

  // Wait for call to complete
  console.log("PHONE_CALL_E2E: waiting for call to complete...");
  const completedSession = await waitForSession(geminiLivePhone, session.id, 120_000);
  console.log(`PHONE_CALL_E2E: session finished with status: ${completedSession.status}`);

  if (completedSession.status === "failed") {
    throw new Error(`Call failed: ${completedSession.error ?? "unknown error"}`);
  }

  // Read transcript
  const transcriptPath = completedSession.transcriptLogPath;
  assert(fs.existsSync(transcriptPath), `Transcript file not found at ${transcriptPath}`);

  const transcriptContent = fs.readFileSync(transcriptPath, "utf8");
  const transcriptEntries = transcriptContent
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<Record<string, unknown>>;

  console.log(`PHONE_CALL_E2E: transcript has ${transcriptEntries.length} entries`);

  // Log all entry types for debugging
  const typeCounts: Record<string, number> = {};
  for (const entry of transcriptEntries) {
    const t = String(entry.type);
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    // Log entries with text content
    if (typeof entry.text === "string" && entry.text.trim()) {
      console.log(`PHONE_CALL_E2E:   [${t}] ${entry.text.slice(0, 120)}`);
    }
  }
  console.log(`PHONE_CALL_E2E: entry types: ${JSON.stringify(typeCounts)}`);

  // Collect all transcript text (both caller input and assistant output are logged as "transcript")
  const allTranscriptEntries = transcriptEntries
    .filter((e) => e.type === "transcript" && typeof e.text === "string")
    .map((e) => (e.text as string).toLowerCase());

  const allTranscriptText = allTranscriptEntries.join(" ");
  console.log(`PHONE_CALL_E2E: all transcript text: ${allTranscriptText}`);

  // The test number plays: "The quick brown fox jumps over the lazy dog.
  //   The test phrase is alpha bravo charlie delta echo."
  // Assert Gemini transcribed at least some of these distinctive words.
  // TTS transcription may split across entries and garble slightly, so check broadly.
  const expectedWords = ["brown", "dog", "alpha", "bravo", "charlie", "delta", "echo"];
  const foundWords = expectedWords.filter((word) => allTranscriptText.includes(word));

  assert(
    foundWords.length >= 3,
    `Expected transcript to contain at least 3 of [${expectedWords.join(", ")}] `
      + `but found [${foundWords.join(", ")}]. Full text: "${allTranscriptText}"`,
  );

  assert.equal(
    completedSession.status,
    "completed",
    `Expected session status "completed" but got "${completedSession.status}"`,
  );

  console.log("PHONE_CALL_E2E_OK");
}

function cleanup() {
  if (cloudflaredProcess) {
    try {
      cloudflaredProcess.kill();
    } catch {}
  }
  if (serverInstance) {
    try {
      serverInstance.stop();
    } catch {}
  }
  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
  if (tempRoot) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    cleanup();
    process.exit(1);
  });
