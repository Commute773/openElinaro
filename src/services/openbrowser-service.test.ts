import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { getRuntimeConfig, saveRuntimeConfig, type RuntimeConfig } from "../config/runtime-config";
import { OpenBrowserService } from "./openbrowser-service";
import { ProfileService } from "./profiles";
import { SecretStoreService } from "./secret-store-service";
import { buildToolErrorEnvelope } from "./tool-error-service";

const tempDirs: string[] = [];
const SHARED_PYTHON_BIN = process.platform === "win32"
  ? path.join(process.cwd(), ".openelinaro", "python", ".venv", "Scripts", "python.exe")
  : path.join(process.cwd(), ".openelinaro", "python", ".venv", "bin", "python");
const OPENBROWSER_RUNNER_PATH = path.join(process.cwd(), "scripts", "openbrowser_runner.py");

function writeProfileRegistry(runtimeRoot: string) {
  fs.mkdirSync(path.join(runtimeRoot, ".openelinarotest", "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeRoot, ".openelinarotest", "profiles", "registry.json"),
    `${JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "root",
          name: "Root",
          roles: ["root"],
          memoryNamespace: "root",
        },
        {
          id: "restricted",
          name: "Restricted",
          roles: ["restricted"],
          memoryNamespace: "restricted",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
}

function createSpawnTelemetry() {
  return {
    instrumentSpawn: async (params: {
      command: string;
      args: string[];
      timeoutMs?: number;
      input?: string;
      options?: { cwd?: string; env?: Record<string, string>; stdio?: string[] };
    }) => {
      const { spawn } = await import("node:child_process");
      return await new Promise<{
        stdout: string;
        stderr: string;
        code: number;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        const child = spawn(params.command, params.args, {
          ...(params.options ?? {}),
          stdio: "pipe",
        });
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        const timer = params.timeoutMs
          ? setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error(`${params.command} timed out after ${params.timeoutMs}ms.`));
            }, params.timeoutMs)
          : undefined;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk: string) => stderrChunks.push(chunk));
        child.on("error", (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code, signal) => {
          if (timer) clearTimeout(timer);
          resolve({
            stdout: stdoutChunks.join(""),
            stderr: stderrChunks.join(""),
            code: code ?? -1,
            signal,
          });
        });
        if (typeof params.input === "string") {
          child.stdin.write(params.input);
        }
        child.stdin.end();
      });
    },
  };
}

function createStubRunner() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openbrowser-runner-"));
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
      "  'ok': True,",
      "  'sessionId': 'stub-session',",
      "  'title': 'Stub Browser Page',",
      "  'finalUrl': payload.get('startUrl', 'about:blank'),",
      "  'artifactDir': payload['artifactDir'],",
      "  'screenshots': [],",
      "  'stepResults': [{",
      "    'index': 0,",
      "    'type': payload['actions'][0]['type'],",
      "    'status': 'ok',",
      "    'detail': payload['userDataDir'],",
      "  }],",
      "}));",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(runnerPath, 0o755);
  return runnerPath;
}

function createPersistentStubRunner() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openbrowser-session-runner-"));
  tempDirs.push(tempDir);
  const runnerPath = path.join(tempDir, "session-runner.py");
  fs.writeFileSync(
    runnerPath,
    [
      "#!/usr/bin/env python3",
      "import json",
      "import sys",
      "",
      "current_url = 'about:blank'",
      "session_seen = False",
      "for raw_line in sys.stdin:",
      "    line = raw_line.strip()",
      "    if not line:",
      "        continue",
      "    message = json.loads(line)",
      "    payload = message['payload']",
      "    reused_session = session_seen and not message.get('resetSession', False)",
      "    if message.get('resetSession'):",
      "        current_url = 'about:blank'",
      "        session_seen = False",
      "    if payload.get('startUrl'):",
      "        current_url = payload['startUrl']",
      "    for action in payload.get('actions', []):",
      "        if action['type'] == 'navigate':",
      "            current_url = action['url']",
      "    session_seen = True",
      "    sys.stdout.write(json.dumps({",
      "        'commandId': message['commandId'],",
      "        'ok': True,",
      "        'result': {",
      "            'ok': True,",
      "            'sessionId': 'persistent-stub-session',",
      "            'reusedSession': reused_session,",
      "            'title': 'Stub Browser Page',",
      "            'finalUrl': current_url,",
      "            'artifactDir': payload['artifactDir'],",
      "            'screenshots': [],",
      "            'stepResults': [{",
      "                'index': 0,",
      "                'type': payload['actions'][0]['type'],",
      "                'status': 'ok',",
      "                'detail': current_url,",
      "            }],",
      "        },",
      "    }) + '\\n')",
      "    sys.stdout.flush()",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(runnerPath, 0o755);
  return runnerPath;
}

function createNoisyPersistentStubRunner() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openbrowser-noisy-session-runner-"));
  tempDirs.push(tempDir);
  const runnerPath = path.join(tempDir, "noisy-session-runner.py");
  fs.writeFileSync(
    runnerPath,
    [
      "#!/usr/bin/env python3",
      "import json",
      "import sys",
      "",
      "for raw_line in sys.stdin:",
      "    line = raw_line.strip()",
      "    if not line:",
      "        continue",
      "    message = json.loads(line)",
      "    payload = message['payload']",
      "    sys.stdout.write('DEBUG browser session reused\\n')",
      "    sys.stdout.flush()",
      "    sys.stdout.write(json.dumps({",
      "        'commandId': message['commandId'],",
      "        'ok': True,",
      "        'result': {",
      "            'ok': True,",
      "            'sessionId': 'noisy-persistent-stub-session',",
      "            'reusedSession': True,",
      "            'title': 'Stub Browser Page',",
      "            'finalUrl': payload.get('startUrl', 'about:blank'),",
      "            'artifactDir': payload['artifactDir'],",
      "            'screenshots': [],",
      "            'stepResults': [{",
      "                'index': 0,",
      "                'type': payload['actions'][0]['type'],",
      "                'status': 'ok',",
      "                'detail': 'ok',",
      "            }],",
      "        },",
      "    }) + '\\n')",
      "    sys.stdout.flush()",
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
  delete process.env.OPENELINARO_ROOT_DIR;
});

describe("OpenBrowserService", () => {
  test("falls back to the bundled runner when config leaves runnerScript blank", () => {
    const previousRootDir = process.env.OPENELINARO_ROOT_DIR;
    const previousServiceRootDir = process.env.OPENELINARO_SERVICE_ROOT_DIR;
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openbrowser-config-runtime-"));
    const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openbrowser-config-service-"));
    tempDirs.push(runtimeRoot, serviceRoot);
    process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
    process.env.OPENELINARO_SERVICE_ROOT_DIR = serviceRoot;
    fs.mkdirSync(path.join(serviceRoot, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(serviceRoot, "scripts", "openbrowser_runner.py"), "# stub\n", "utf8");

    try {
      const config = structuredClone(getRuntimeConfig()) as RuntimeConfig;
      config.openbrowser.runnerScript = "";
      saveRuntimeConfig(config);

      const service = new OpenBrowserService({ pythonBin: "python3" });
      expect((service as unknown as { runnerScript: string }).runnerScript)
        .toBe(path.join(serviceRoot, "scripts", "openbrowser_runner.py"));
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

  test("uses a stable profile-scoped user data dir by default", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openbrowser-runtime-"));
    tempDirs.push(runtimeRoot);
    writeProfileRegistry(runtimeRoot);
    process.env.OPENELINARO_ROOT_DIR = runtimeRoot;

    const telemetry = {
      ...createSpawnTelemetry(),
    };

    const service = new OpenBrowserService({
      pythonBin: "python3",
      runnerScript: createStubRunner(),
      telemetry: telemetry as never,
      profiles: new ProfileService("restricted"),
    });

    const result = await service.run({
      startUrl: "https://example.com/login",
      actions: [{ type: "wait", ms: 1000 }],
    });

    const expectedUserDataDir = path.join(
      runtimeRoot,
      ".openelinarotest",
      "openbrowser",
      "profiles",
      "restricted",
      "user-data",
    );

    expect(result.stepResults[0]?.detail).toBe(expectedUserDataDir);
    expect(fs.existsSync(expectedUserDataDir)).toBe(true);
  });

  test("resolves secret references before invoking the runner", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openbrowser-secret-runtime-"));
    tempDirs.push(runtimeRoot);
    writeProfileRegistry(runtimeRoot);
    process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
    process.env.OPENELINARO_SECRET_KEY = "openbrowser-secret-test-key";

    const secrets = new SecretStoreService();
    secrets.saveSecret({
      name: "prepaid_card",
      kind: "payment_card",
      fields: {
        number: "test-number-1234",
        expMonth: "12",
      },
    });

    const runnerPath = path.join(runtimeRoot, "resolve-secret-runner.py");
    fs.writeFileSync(
      runnerPath,
      [
        "#!/usr/bin/env python3",
        "import json",
        "import sys",
        "payload = json.loads(sys.stdin.read())",
        "value = payload['actions'][0]['args'][0]['number']",
        "sys.stdout.write(json.dumps({",
        "  'ok': True,",
        "  'sessionId': 'stub-session',",
        "  'title': 'Stub Browser Page',",
        "  'finalUrl': payload.get('startUrl', 'about:blank'),",
        "  'artifactDir': payload['artifactDir'],",
        "  'screenshots': [],",
        "  'stepResults': [{",
        "    'index': 0,",
        "    'type': payload['actions'][0]['type'],",
        "    'status': 'ok',",
        "    'detail': value,",
        "  }],",
        "}));",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(runnerPath, 0o755);

    const service = new OpenBrowserService({
      pythonBin: "python3",
      runnerScript: runnerPath,
      telemetry: {
        ...createSpawnTelemetry(),
      } as never,
      profiles: new ProfileService("root"),
      secrets,
    });

    const result = await service.run({
      actions: [
        {
          type: "evaluate",
          expression: "(card) => card.number",
          args: [
            {
              number: { secretRef: "prepaid_card.number" },
              expMonth: { secretRef: "prepaid_card.expMonth" },
            },
          ],
          captureResult: false,
        },
      ],
    });

    expect(result.stepResults[0]?.detail).toBe("test-number-1234");
    expect(result.stepResults[0]?.value).toBeUndefined();
  });

  test("reuses a persistent browser session when sessionKey is provided", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openbrowser-persistent-runtime-"));
    tempDirs.push(runtimeRoot);
    writeProfileRegistry(runtimeRoot);
    process.env.OPENELINARO_ROOT_DIR = runtimeRoot;

    const service = new OpenBrowserService({
      pythonBin: "python3",
      runnerScript: createPersistentStubRunner(),
      sessionIdleMs: 60_000,
      profiles: new ProfileService("root"),
    });

    try {
      const first = await service.run({
        sessionKey: "chat:openbrowser",
        startUrl: "https://example.com",
        actions: [{ type: "navigate", url: "https://example.com/checkout" }],
      });
      const second = await service.run({
        sessionKey: "chat:openbrowser",
        actions: [{ type: "wait", ms: 10 }],
      });

      expect(first.sessionKey).toBe("chat:openbrowser");
      expect(first.finalUrl).toBe("https://example.com/checkout");
      expect(first.reusedSession).toBe(false);
      expect(second.finalUrl).toBe("https://example.com/checkout");
      expect(second.reusedSession).toBe(true);
    } finally {
      await service.dispose();
    }
  });

  test("ignores non-json stdout noise from persistent browser sessions", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openbrowser-noisy-persistent-runtime-"));
    tempDirs.push(runtimeRoot);
    writeProfileRegistry(runtimeRoot);
    process.env.OPENELINARO_ROOT_DIR = runtimeRoot;

    const service = new OpenBrowserService({
      pythonBin: "python3",
      runnerScript: createNoisyPersistentStubRunner(),
      sessionIdleMs: 60_000,
      profiles: new ProfileService("root"),
    });

    try {
      const result = await service.run({
        sessionKey: "chat:openbrowser",
        startUrl: "https://example.com/noisy",
        actions: [{ type: "wait", ms: 10 }],
      });

      expect(result.finalUrl).toBe("https://example.com/noisy");
      expect(result.stepResults[0]?.detail).toBe("ok");
    } finally {
      await service.dispose();
    }
  });

  test("supports a type action with one screenshot for the whole typed string", async () => {
    if (!fs.existsSync(SHARED_PYTHON_BIN)) {
      return;
    }

    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openbrowser-real-runner-"));
    tempDirs.push(runtimeRoot);
    writeProfileRegistry(runtimeRoot);
    process.env.OPENELINARO_ROOT_DIR = runtimeRoot;

    const htmlPath = path.join(runtimeRoot, "type-action.html");
    fs.writeFileSync(
      htmlPath,
      "<html><body><input id=\"email\"><script>window.readValue=()=>document.getElementById('email').value;</script></body></html>",
      "utf8",
    );

    const service = new OpenBrowserService({
      pythonBin: SHARED_PYTHON_BIN,
      runnerScript: OPENBROWSER_RUNNER_PATH,
      telemetry: createSpawnTelemetry() as never,
      profiles: new ProfileService("root"),
    });

    const result = await service.run({
      actions: [
        { type: "navigate", url: pathToFileURL(htmlPath).toString(), waitMs: 100 },
        { type: "evaluate", expression: "() => { document.getElementById('email').focus(); return 'focused'; }" },
        { type: "type", text: "hello@example.com" },
        { type: "evaluate", expression: "() => document.getElementById('email').value", captureResult: true },
      ],
    });

    expect(result.stepResults.map((step) => step.type)).toEqual(["navigate", "evaluate", "type", "evaluate"]);
    expect(result.stepResults[2]?.detail).toContain("typed 17 characters");
    expect(result.stepResults[3]?.value).toBe("hello@example.com");
    expect(result.screenshots).toHaveLength(4);
  });

  test("propagates structured openbrowser failure details into the tool error envelope", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openbrowser-error-runtime-"));
    tempDirs.push(runtimeRoot);
    writeProfileRegistry(runtimeRoot);
    process.env.OPENELINARO_ROOT_DIR = runtimeRoot;

    const runnerPath = path.join(runtimeRoot, "error-runner.py");
    fs.writeFileSync(
      runnerPath,
      [
        "#!/usr/bin/env python3",
        "import json",
        "import sys",
        "payload = json.loads(sys.stdin.read())",
        "sys.stdout.write(json.dumps({",
        "  'ok': False,",
        "  'error': {",
        "    'message': 'OpenBrowser action failed during evaluate at step 2: boom',",
        "    'category': 'action_error',",
        "    'actionIndex': 1,",
        "    'actionType': 'evaluate',",
        "    'artifactDir': payload['artifactDir'],",
        "    'pageTitle': 'Account Login',",
        "    'pageUrl': 'https://purelymail.com/manage/',",
        "    'screenshotPath': payload['artifactDir'] + '/failure.png',",
        "    'screenshotFormat': 'png',",
        "    'exception': 'TypeError: boom'",
        "  }",
        "}));",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(runnerPath, 0o755);

    const service = new OpenBrowserService({
      pythonBin: "python3",
      runnerScript: runnerPath,
      telemetry: createSpawnTelemetry() as never,
      profiles: new ProfileService("root"),
    });

    let thrown: unknown;
    try {
      await service.run({
        actions: [{ type: "evaluate", expression: "() => 1" }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const envelope = buildToolErrorEnvelope("openbrowser", thrown);
    expect(envelope.error.type).toBe("tool_error");
    expect(envelope.details).toMatchObject({
      category: "action_error",
      actionIndex: 1,
      actionType: "evaluate",
      pageTitle: "Account Login",
      pageUrl: "https://purelymail.com/manage/",
    });
  });
});
