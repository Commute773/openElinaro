import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ExtensionRegistryService } from "./extension-registry-service";

const tempDirs: string[] = [];
let previousUserDataDir: string | undefined;

function withIsolatedUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-ext-test-"));
  tempDirs.push(dir);
  process.env.OPENELINARO_USER_DATA_DIR = dir;
  return dir;
}

function writeExtension(base: string, id: string, manifest: Record<string, unknown>, entrypointSource?: string) {
  const extDir = path.join(base, "extensions", id);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, "extension.json"), JSON.stringify(manifest));
  if (entrypointSource !== undefined) {
    const entrypoint = (manifest.entrypoint as string) ?? "index.ts";
    fs.writeFileSync(path.join(extDir, entrypoint), entrypointSource);
  }
}

beforeEach(() => {
  previousUserDataDir = process.env.OPENELINARO_USER_DATA_DIR;
});

afterEach(() => {
  if (previousUserDataDir === undefined) {
    delete process.env.OPENELINARO_USER_DATA_DIR;
  } else {
    process.env.OPENELINARO_USER_DATA_DIR = previousUserDataDir;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ExtensionRegistryService", () => {
  test("scan returns empty when extensions dir does not exist", () => {
    withIsolatedUserData();
    const svc = new ExtensionRegistryService();
    const result = svc.scan();
    expect(result).toEqual([]);
  });

  test("scan discovers a valid extension", () => {
    const base = withIsolatedUserData();
    writeExtension(base, "hello-world", {
      id: "hello-world",
      name: "Hello World",
      version: "1.0.0",
      description: "A test extension",
      author: "Test",
      entrypoint: "index.ts",
    });

    const svc = new ExtensionRegistryService();
    const result = svc.scan();
    expect(result.length).toBe(1);
    const ext = result[0]!;
    expect(ext.status).toBe("valid");
    expect(ext.manifest!.id).toBe("hello-world");
    expect(ext.manifest!.name).toBe("Hello World");
    expect(ext.error).toBeNull();
  });

  test("scan marks extension as discovered when manifest is missing", () => {
    const base = withIsolatedUserData();
    const extDir = path.join(base, "extensions", "no-manifest");
    fs.mkdirSync(extDir, { recursive: true });

    const svc = new ExtensionRegistryService();
    const result = svc.scan();
    expect(result.length).toBe(1);
    const ext = result[0]!;
    expect(ext.status).toBe("discovered");
    expect(ext.manifest).toBeNull();
    expect(ext.error).toContain("Missing extension.json");
  });

  test("scan marks extension as invalid when manifest fails validation", () => {
    const base = withIsolatedUserData();
    writeExtension(base, "bad-ext", { id: "BAD ID!", version: "1.0.0" });

    const svc = new ExtensionRegistryService();
    const result = svc.scan();
    expect(result.length).toBe(1);
    const ext = result[0]!;
    expect(ext.status).toBe("invalid");
    expect(ext.manifest).toBeNull();
    expect(ext.error).toBeTruthy();
  });

  test("listValid returns only valid extensions", () => {
    const base = withIsolatedUserData();
    writeExtension(base, "good", {
      id: "good",
      name: "Good Extension",
      version: "0.1.0",
      entrypoint: "main.ts",
    });
    writeExtension(base, "bad", { id: "BAD!", version: "nope" });

    const svc = new ExtensionRegistryService();
    svc.scan();
    expect(svc.listValid().length).toBe(1);
    expect(svc.list().length).toBe(2);
  });

  test("loadAll loads extension with activate function", async () => {
    const base = withIsolatedUserData();
    writeExtension(
      base,
      "test-ext",
      { id: "test-ext", name: "Test Extension", version: "1.0.0", entrypoint: "index.ts" },
      `export function activate(api) { api.registerTool("greet", {}, async () => "hello"); }`,
    );

    const svc = new ExtensionRegistryService();
    svc.scan();
    await svc.loadAll();

    const ext = svc.list().find((e) => e.manifest?.id === "test-ext");
    expect(ext?.status).toBe("loaded");
    expect(svc.getRegisteredTools().has("test-ext.greet")).toBe(true);
  });

  test("loadAll sets error status when entrypoint has no activate", async () => {
    const base = withIsolatedUserData();
    writeExtension(
      base,
      "no-activate",
      { id: "no-activate", name: "No Activate", version: "1.0.0", entrypoint: "index.ts" },
      `export const value = 42;`,
    );

    const svc = new ExtensionRegistryService();
    svc.scan();
    await svc.loadAll();

    const ext = svc.list().find((e) => e.manifest?.id === "no-activate");
    expect(ext?.status).toBe("error");
    expect(ext?.error).toContain("activate");
  });

  test("loadAll continues loading after one extension fails", async () => {
    const base = withIsolatedUserData();
    writeExtension(
      base,
      "broken",
      { id: "broken", name: "Broken", version: "1.0.0", entrypoint: "index.ts" },
      `export function activate() { throw new Error("boom"); }`,
    );
    writeExtension(
      base,
      "good",
      { id: "good", name: "Good", version: "1.0.0", entrypoint: "index.ts" },
      `export function activate(api) { api.registerTool("ping", {}, async () => "pong"); }`,
    );

    const svc = new ExtensionRegistryService();
    svc.scan();
    await svc.loadAll();

    const broken = svc.list().find((e) => e.manifest?.id === "broken");
    const good = svc.list().find((e) => e.manifest?.id === "good");
    expect(broken?.status).toBe("error");
    expect(good?.status).toBe("loaded");
  });

  test("emitEvent calls subscribed handlers", async () => {
    const base = withIsolatedUserData();
    writeExtension(
      base,
      "eventer",
      { id: "eventer", name: "Eventer", version: "1.0.0", entrypoint: "index.ts" },
      `export const received = [];
export function activate(api) {
  api.onEvent("test-event", (...args) => received.push(args));
}`,
    );

    const svc = new ExtensionRegistryService();
    svc.scan();
    await svc.loadAll();

    svc.emitEvent("test-event", "a", 1);
    const extDir = path.join(base, "extensions", "eventer");
    const mod = await import(path.join(extDir, "index.ts"));
    expect(mod.received.length).toBe(1);
    expect(mod.received[0]).toEqual(["a", 1]);
  });

  test("registerToolLibrary stores library registration", async () => {
    const base = withIsolatedUserData();
    writeExtension(
      base,
      "lib-ext",
      { id: "lib-ext", name: "Lib Ext", version: "1.0.0", entrypoint: "index.ts" },
      `export function activate(api) {
  api.registerTool("foo", {}, async () => "foo");
  api.registerTool("bar", {}, async () => "bar");
  api.registerToolLibrary("my-lib", "A test library", ["foo", "bar"]);
}`,
    );

    const svc = new ExtensionRegistryService();
    svc.scan();
    await svc.loadAll();

    const lib = svc.getRegisteredLibraries().get("my-lib");
    expect(lib).toBeTruthy();
    expect(lib!.extensionId).toBe("lib-ext");
    expect(lib!.toolNames).toEqual(["foo", "bar"]);
  });

  test("scan ignores non-directory entries", () => {
    const base = withIsolatedUserData();
    const extDir = path.join(base, "extensions");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "stray-file.txt"), "not a directory");

    const svc = new ExtensionRegistryService();
    const result = svc.scan();
    expect(result.length).toBe(0);
  });
});
