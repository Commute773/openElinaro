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

function writeExtension(base: string, id: string, manifest: Record<string, unknown>) {
  const extDir = path.join(base, "extensions", id);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, "extension.json"), JSON.stringify(manifest));
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
  test("scan returns empty when extensions dir does not exist", async () => {
    withIsolatedUserData();
    const svc = new ExtensionRegistryService();
    const result = await svc.scan();
    expect(result).toEqual([]);
  });

  test("scan discovers a valid extension", async () => {
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
    const result = await svc.scan();
    expect(result.length).toBe(1);
    const ext = result[0]!;
    expect(ext.status).toBe("valid");
    expect(ext.manifest!.id).toBe("hello-world");
    expect(ext.manifest!.name).toBe("Hello World");
    expect(ext.error).toBeNull();
  });

  test("scan marks extension as discovered when manifest is missing", async () => {
    const base = withIsolatedUserData();
    const extDir = path.join(base, "extensions", "no-manifest");
    fs.mkdirSync(extDir, { recursive: true });

    const svc = new ExtensionRegistryService();
    const result = await svc.scan();
    expect(result.length).toBe(1);
    const ext = result[0]!;
    expect(ext.status).toBe("discovered");
    expect(ext.manifest).toBeNull();
    expect(ext.error).toContain("Missing extension.json");
  });

  test("scan marks extension as invalid when manifest fails validation", async () => {
    const base = withIsolatedUserData();
    writeExtension(base, "bad-ext", { id: "BAD ID!", version: "1.0.0" });

    const svc = new ExtensionRegistryService();
    const result = await svc.scan();
    expect(result.length).toBe(1);
    const ext = result[0]!;
    expect(ext.status).toBe("invalid");
    expect(ext.manifest).toBeNull();
    expect(ext.error).toBeTruthy();
  });

  test("listValid returns only valid extensions", async () => {
    const base = withIsolatedUserData();
    writeExtension(base, "good", {
      id: "good",
      name: "Good Extension",
      version: "0.1.0",
      entrypoint: "main.ts",
    });
    writeExtension(base, "bad", { id: "BAD!", version: "nope" });

    const svc = new ExtensionRegistryService();
    await svc.scan();
    expect(svc.listValid().length).toBe(1);
    expect(svc.list().length).toBe(2);
  });

  test("loadAll logs stub message without crashing", async () => {
    const base = withIsolatedUserData();
    writeExtension(base, "stub", {
      id: "stub",
      name: "Stub",
      version: "1.0.0",
      entrypoint: "index.ts",
    });

    const svc = new ExtensionRegistryService();
    await svc.scan();
    // Should not throw
    svc.loadAll();
  });

  test("scan ignores non-directory entries", async () => {
    const base = withIsolatedUserData();
    const extDir = path.join(base, "extensions");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "stray-file.txt"), "not a directory");

    const svc = new ExtensionRegistryService();
    const result = await svc.scan();
    expect(result.length).toBe(0);
  });
});
