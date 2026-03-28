import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = process.cwd();

function hasPhoneCallE2ePrerequisites() {
  // Need Vonage API key/secret for updating test app webhook
  if (!process.env.VONAGE_API_KEY || !process.env.VONAGE_API_SECRET) {
    return false;
  }
  // Need production secret store with vonage + gemini secrets
  const secretStorePath = path.join(os.homedir(), ".openelinaro", "secret-store.json");
  if (!fs.existsSync(secretStorePath)) {
    return false;
  }
  try {
    const store = JSON.parse(fs.readFileSync(secretStorePath, "utf8")) as {
      profiles?: Record<string, { secrets?: Record<string, unknown> }>;
    };
    const secrets = store.profiles?.root?.secrets;
    return Boolean(secrets?.vonage && secrets?.gemini);
  } catch {
    return false;
  }
}

const RUN_PHONE_E2E =
  process.env.OPENELINARO_ENABLE_PHONE_E2E !== "0" && hasPhoneCallE2ePrerequisites();

describe("phone call e2e", () => {
  // Skip when Vonage API keys or Gemini secrets are not available.
  // Disable explicitly with OPENELINARO_ENABLE_PHONE_E2E=0.
  const liveTest = RUN_PHONE_E2E ? test : test.skip;

  liveTest("calls a test number and verifies Gemini transcribes the TTS audio", () => {
    const runnerPath = path.join(repoRoot, "src/app/phone-call.e2e.runner.ts");
    const stdout = execFileSync("bun", ["run", runnerPath], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: 300_000,
    });

    expect(stdout).toContain("PHONE_CALL_E2E_OK");
  }, 320_000);
});
