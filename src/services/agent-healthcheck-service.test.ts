import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { AppResponse } from "../domain/assistant";
import {
  AGENT_HEALTHCHECK_PROMPT,
  AgentHealthcheckService,
  type AgentHealthcheckResponse,
} from "./agent-healthcheck-service";

async function waitForResponseFile(filePath: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as AgentHealthcheckResponse;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

const services: AgentHealthcheckService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) {
    service.stop();
  }
});

describe("AgentHealthcheckService", () => {
  test("marks a request healthy when the immediate reply contains HEALTHCHECK_OK", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-healthcheck-"));
    const service = new AgentHealthcheckService({ rootDir, pollIntervalMs: 10 });
    services.push(service);
    service.start({
      run: async ({ prompt }) => {
        expect(prompt).toBe(AGENT_HEALTHCHECK_PROMPT);
        return {
          requestId: "healthcheck-1",
          mode: "immediate",
          message: "HEALTHCHECK_OK",
        } satisfies AppResponse;
      },
    });

    const requestPath = path.join(service.getPaths().requestsDir, "healthcheck-1.json");
    fs.writeFileSync(requestPath, `${JSON.stringify({
      id: "healthcheck-1",
      createdAt: new Date().toISOString(),
    })}\n`);

    const response = await waitForResponseFile(
      path.join(service.getPaths().responsesDir, "healthcheck-1.json"),
    );

    expect(response.status).toBe("ok");
    expect(response.immediateMessage).toBe("HEALTHCHECK_OK");
  });

  test("waits for a background reply before succeeding", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-healthcheck-"));
    const service = new AgentHealthcheckService({ rootDir, pollIntervalMs: 10 });
    services.push(service);
    service.start({
      run: async ({ onBackgroundResponse }) => {
        setTimeout(() => {
          void onBackgroundResponse?.("HEALTHCHECK_OK");
        }, 25);
        return {
          requestId: "healthcheck-2",
          mode: "accepted",
          message: "queued background work",
        } satisfies AppResponse;
      },
    });

    const requestPath = path.join(service.getPaths().requestsDir, "healthcheck-2.json");
    fs.writeFileSync(requestPath, `${JSON.stringify({
      id: "healthcheck-2",
      createdAt: new Date().toISOString(),
      timeoutMs: 500,
    })}\n`);

    const response = await waitForResponseFile(
      path.join(service.getPaths().responsesDir, "healthcheck-2.json"),
    );

    expect(response.status).toBe("ok");
    expect(response.backgroundMessage).toBe("HEALTHCHECK_OK");
  });

  test("fails when the response never includes HEALTHCHECK_OK", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-healthcheck-"));
    const service = new AgentHealthcheckService({ rootDir, pollIntervalMs: 10 });
    services.push(service);
    service.start({
      run: async () => ({
        requestId: "healthcheck-3",
        mode: "immediate",
        message: "still booting",
      } satisfies AppResponse),
    });

    const requestPath = path.join(service.getPaths().requestsDir, "healthcheck-3.json");
    fs.writeFileSync(requestPath, `${JSON.stringify({
      id: "healthcheck-3",
      createdAt: new Date().toISOString(),
    })}\n`);

    const response = await waitForResponseFile(
      path.join(service.getPaths().responsesDir, "healthcheck-3.json"),
    );

    expect(response.status).toBe("error");
    expect(response.error).toContain("HEALTHCHECK_OK");
  });
});
