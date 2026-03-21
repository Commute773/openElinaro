import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { updateTestRuntimeConfig } from "../test/runtime-config-test-helpers";
import { CommunicationsStore } from "./communications-store";
import { SecretStoreService } from "./secret-store-service";
import { VonageService } from "./vonage-service";

const tempDirs: string[] = [];
const previousEnv = {
  OPENELINARO_ROOT_DIR: process.env.OPENELINARO_ROOT_DIR,
  OPENELINARO_SECRET_KEY: process.env.OPENELINARO_SECRET_KEY,
};
const previousCwd = process.cwd();

function withRuntimeRoot() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-vonage-"));
  tempDirs.push(runtimeRoot);
  process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
  process.chdir(runtimeRoot);
  return runtimeRoot;
}

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  process.chdir(previousCwd);
}

function createWebhookJwt(secret: string, claims?: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    ...claims,
  }), "utf8").toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

afterEach(() => {
  restoreEnv();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("VonageService", () => {
  test("reports the dashboard webhook values and configuration status", () => {
    withRuntimeRoot();
    process.env.OPENELINARO_SECRET_KEY = "vonage-test-key";
    updateTestRuntimeConfig((config) => {
      config.core.http.port = 4010;
      config.communications.enabled = true;
      config.communications.publicBaseUrl = "https://openelinaro.example.com";
      config.communications.vonage.applicationId = "app-123";
      config.communications.vonage.privateKeySecretRef = "vonage.private_key";
      config.communications.vonage.signatureSecretRef = "vonage.signature_secret";
      config.communications.vonage.defaultFromNumber = "+15145550111";
      config.communications.vonage.defaultMessageFrom = "+15145550112";
    });

    const secrets = new SecretStoreService();
    secrets.saveSecret({
      name: "vonage",
      fields: {
        private_key: "test-private-key",
        signature_secret: "test-signature-secret",
      },
    });

    const service = new VonageService({ secrets });
    const status = service.getStatus();

    expect(status.configured).toBe(true);
    expect(status.webhookUrls.voiceAnswer).toBe("https://openelinaro.example.com/webhooks/vonage/voice/answer");
    expect(status.webhookUrls.messagesInbound).toBe("https://openelinaro.example.com/webhooks/vonage/messages/inbound");
    expect(service.formatStatus(status)).toContain("Voice answer URL: GET https://openelinaro.example.com/webhooks/vonage/voice/answer");
    expect(service.formatStatus(status)).toContain("Messages inbound URL: POST https://openelinaro.example.com/webhooks/vonage/messages/inbound");
  });

  test("stores verified voice and message webhook events", async () => {
    const runtimeRoot = withRuntimeRoot();
    process.env.OPENELINARO_SECRET_KEY = "vonage-webhook-key";
    updateTestRuntimeConfig((config) => {
      config.communications.enabled = true;
      config.communications.vonage.signatureSecretRef = "vonage.signature_secret";
    });

    const secrets = new SecretStoreService();
    secrets.saveSecret({
      name: "vonage",
      fields: {
        signature_secret: "signed-webhook-secret",
      },
    });
    const store = new CommunicationsStore({
      storePath: path.join(runtimeRoot, ".openelinarotest", "communications", "store.json"),
    });
    const service = new VonageService({ store, secrets });
    const token = createWebhookJwt("signed-webhook-secret");

    const answerResponse = await service.handleVoiceAnswerWebhook(new Request(
      "http://localhost/webhooks/vonage/voice/answer?uuid=call-1&from=%2B15145550001&to=%2B15145550002",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    ));
    expect(answerResponse.status).toBe(200);
    expect(await answerResponse.json()).toEqual([
      {
        action: "talk",
        text: "The assistant is online, but live inbound calling is not configured yet. Please send a text message instead.",
      },
    ]);

    const messageResponse = await service.handleMessagesInboundWebhook(new Request(
      "http://localhost/webhooks/vonage/messages/inbound",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message_uuid: "msg-1",
          channel: "sms",
          direction: "inbound",
          from: "+15145550003",
          to: "+15145550004",
          text: "hello from the network",
          status: "received",
        }),
      },
    ));
    expect(messageResponse.status).toBe(200);

    const call = store.getCall("call-1");
    const message = store.getMessage("msg-1");
    expect(call?.events[0]?.verified).toBe(true);
    expect(call?.from).toBe("+15145550001");
    expect(message?.events[0]?.verified).toBe(true);
    expect(message?.text).toBe("hello from the network");
  });
});
