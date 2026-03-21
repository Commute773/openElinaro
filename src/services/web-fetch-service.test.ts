import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "bun:test";
import { getRuntimeConfig, saveRuntimeConfig, type RuntimeConfig } from "../config/runtime-config";
import { WebFetchService } from "./web-fetch-service";

const tempDirs: string[] = [];
const SHARED_PYTHON_BIN = process.platform === "win32"
  ? path.join(process.cwd(), ".openelinaro", "python", ".venv", "Scripts", "python.exe")
  : path.join(process.cwd(), ".openelinaro", "python", ".venv", "bin", "python");
const CRAWL4AI_RUNNER_PATH = path.join(process.cwd(), "scripts", "crawl4ai_fetch_runner.py");

function createStubRunner() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-fetch-runner-"));
  tempDirs.push(tempDir);
  const runnerPath = path.join(tempDir, "runner.py");
  fs.writeFileSync(
    runnerPath,
    [
      "#!/usr/bin/env python3",
      "import json",
      "import sys",
      "payload = json.loads(sys.stdin.read())",
      "sys.stdout.write(json.dumps({",
      "  'url': payload['url'],",
      "  'finalUrl': payload['url'] + '?final=1',",
      "  'format': payload['format'],",
      "  'contentType': 'text/markdown',",
      "  'title': 'Stub Page',",
      "  'content': '# Stub Page\\n\\nFetched through runner.',",
      "  'truncated': False,",
      "  'backend': 'crawl4ai',",
      "  'artifactDir': payload['artifactDir'],",
      "}));",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(runnerPath, 0o755);
  return runnerPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("WebFetchService", () => {
  test("falls back to the bundled runner when config leaves runnerScript blank", () => {
    const previousRootDir = process.env.OPENELINARO_ROOT_DIR;
    const previousServiceRootDir = process.env.OPENELINARO_SERVICE_ROOT_DIR;
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "web-fetch-config-runtime-"));
    const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "web-fetch-config-service-"));
    tempDirs.push(runtimeRoot, serviceRoot);
    process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
    process.env.OPENELINARO_SERVICE_ROOT_DIR = serviceRoot;
    fs.mkdirSync(path.join(serviceRoot, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(serviceRoot, "scripts", "crawl4ai_fetch_runner.py"), "# stub\n", "utf8");

    try {
      const config = structuredClone(getRuntimeConfig()) as RuntimeConfig;
      config.webFetch.runnerScript = "";
      saveRuntimeConfig(config);

      const service = new WebFetchService({ pythonBin: "python3" });
      expect((service as unknown as { runnerScript: string }).runnerScript)
        .toBe(path.join(serviceRoot, "scripts", "crawl4ai_fetch_runner.py"));
    } finally {
      if (previousRootDir === undefined) {
        delete process.env.OPENELINARO_ROOT_DIR;
      } else {
        process.env.OPENELINARO_ROOT_DIR = previousRootDir;
      }
      if (previousServiceRootDir === undefined) {
        delete process.env.OPENELINARO_SERVICE_ROOT_DIR;
      } else {
        process.env.OPENELINARO_SERVICE_ROOT_DIR = previousServiceRootDir;
      }
    }
  });

  test("parses structured output from the Crawl4AI runner", async () => {
    const service = new WebFetchService({
      pythonBin: "python3",
      runnerScript: createStubRunner(),
    });

    const result = await service.fetch({
      url: "https://example.com/docs",
      format: "markdown",
    });

    expect(result.backend).toBe("crawl4ai");
    expect(result.finalUrl).toBe("https://example.com/docs?final=1");
    expect(result.title).toBe("Stub Page");
    expect(result.content).toContain("Fetched through runner.");
    expect(result.artifactDir).toContain("web-fetch/");
  });

  test("fetches a local page through the real Crawl4AI runner when the shared runtime is ready", async () => {
    if (!fs.existsSync(SHARED_PYTHON_BIN)) {
      return;
    }

    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><head><title>Crawl4AI Integration Page</title></head><body><main><h1>Crawl4AI Integration Page</h1><p>Fresh shared runtime fetch test.</p></main></body></html>");
    });

    const address = await new Promise<AddressInfo>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const nextAddress = server.address();
        if (!nextAddress || typeof nextAddress === "string") {
          reject(new Error("Unable to determine test server address."));
          return;
        }
        resolve(nextAddress);
      });
    });

    try {
      const service = new WebFetchService({
        pythonBin: SHARED_PYTHON_BIN,
        runnerScript: CRAWL4AI_RUNNER_PATH,
      });

      const result = await service.fetch({
        url: `http://127.0.0.1:${address.port}/docs`,
        format: "markdown",
        maxChars: 8_000,
      });

      expect(result.backend).toBe("crawl4ai");
      expect(result.content).toContain("Fresh shared runtime fetch test.");
      expect(result.content).toContain("Crawl4AI Integration Page");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
