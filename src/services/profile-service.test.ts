import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProfileRecord } from "../domain/profiles";
import { ProfileService, getDefaultProfileId } from "./profiles";

let runtimeRoot = "";
let previousRootDirEnv: string | undefined;

function writeProfileRegistry(rootDir: string, profiles?: ProfileRecord[]) {
  const registryDir = path.join(rootDir, ".openelinarotest", "profiles");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "registry.json"),
    `${JSON.stringify({
      version: 1,
      profiles: profiles ?? [
        {
          id: "root",
          name: "Root",
          memoryNamespace: "root",
        },
        {
          id: "worker",
          name: "Worker",
          memoryNamespace: "worker",
          shellUser: "deploy",
        },
        {
          id: "remote",
          name: "Remote",
          memoryNamespace: "remote",
          execution: {
            kind: "ssh",
            host: "box.example.com",
            user: "ops",
            port: 2222,
            defaultCwd: "/srv/app",
          },
        },
        {
          id: "limited",
          name: "Limited",
          memoryNamespace: "limited",
          pathRoots: ["/home/limited/projects"],
        },
      ],
    }, null, 2)}\n`,
  );
}

beforeEach(() => {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-profile-test-"));
  process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
  writeProfileRegistry(runtimeRoot);
});

afterEach(() => {
  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = "";
});

describe("ProfileService", () => {
  test("loadRegistry returns all profiles", () => {
    const service = new ProfileService("root");
    const registry = service.loadRegistry();
    expect(registry.version).toBe(1);
    expect(registry.profiles).toHaveLength(4);
  });

  test("getProfile returns a specific profile", () => {
    const service = new ProfileService("root");
    const profile = service.getProfile("worker");
    expect(profile.id).toBe("worker");
    expect(profile.name).toBe("Worker");
  });

  test("getProfile throws for unknown profile", () => {
    const service = new ProfileService("root");
    expect(() => service.getProfile("nonexistent")).toThrow("Profile not found: nonexistent");
  });

  test("getActiveProfile returns the profile matching the constructor argument", () => {
    const service = new ProfileService("worker");
    const profile = service.getActiveProfile();
    expect(profile.id).toBe("worker");
  });

  test("updateProfile modifies a profile and persists", () => {
    const service = new ProfileService("root");
    const updated = service.updateProfile("worker", (profile) => ({
      ...profile,
      name: "Updated Worker",
    }));
    expect(updated.name).toBe("Updated Worker");

    const reloaded = new ProfileService("root").getProfile("worker");
    expect(reloaded.name).toBe("Updated Worker");
  });

  test("updateProfile throws for unknown profile", () => {
    const service = new ProfileService("root");
    expect(() => service.updateProfile("missing", (p) => p)).toThrow("Profile not found: missing");
  });

  test("setProfileDefaults updates thinking level and model fields", () => {
    const service = new ProfileService("root");
    const updated = service.setProfileDefaults("root", {
      defaultThinkingLevel: "high",
      defaultModelId: "claude-opus-4-20250514",
    });
    expect(updated.defaultThinkingLevel).toBe("high");
    expect(updated.defaultModelId).toBe("claude-opus-4-20250514");
  });

  test("getShellUser returns trimmed shellUser or undefined", () => {
    const service = new ProfileService("root");
    expect(service.getShellUser({ shellUser: "deploy" })).toBe("deploy");
    expect(service.getShellUser({ shellUser: "  " })).toBeUndefined();
    expect(service.getShellUser({ shellUser: undefined })).toBeUndefined();
  });

  test("getExecution returns the execution config", () => {
    const service = new ProfileService("root");
    const remote = service.getProfile("remote");
    const execution = service.getExecution(remote);
    expect(execution?.kind).toBe("ssh");
  });

  test("isSshExecutionProfile detects SSH profiles", () => {
    const service = new ProfileService("root");
    const remote = service.getProfile("remote");
    const local = service.getProfile("root");
    expect(service.isSshExecutionProfile(remote)).toBe(true);
    expect(service.isSshExecutionProfile(local)).toBe(false);
  });

  test("getPathRoots returns explicit roots or SSH default cwd", () => {
    const service = new ProfileService("root");
    const limited = service.getProfile("limited");
    expect(service.getPathRoots(limited)).toEqual(["/home/limited/projects"]);

    const remote = service.getProfile("remote");
    expect(service.getPathRoots(remote)).toEqual(["/srv/app"]);

    const root = service.getProfile("root");
    expect(service.getPathRoots(root)).toEqual([]);
  });

  test("getDefaultToolCwd returns cwd for local and defaultCwd for SSH profiles", () => {
    const service = new ProfileService("root");
    const root = service.getProfile("root");
    expect(service.getDefaultToolCwd(root)).toBe(process.cwd());

    const remote = service.getProfile("remote");
    expect(service.getDefaultToolCwd(remote)).toBe("/srv/app");
  });

  test("buildAssistantContext produces a multi-line string with profile info", () => {
    const service = new ProfileService("root");
    const profile = service.getProfile("remote");
    const context = service.buildAssistantContext(profile);
    expect(context).toContain("Profile: remote");
    expect(context).toContain("ssh");
    expect(context).toContain("box.example.com");
  });

  test("getDefaultProfileId returns root", () => {
    expect(getDefaultProfileId()).toBe("root");
  });

  test("saveRegistry persists and reloads", () => {
    const service = new ProfileService("root");
    const registry = service.loadRegistry();
    registry.profiles[0]!.name = "Renamed Root";
    service.saveRegistry(registry);

    const reloaded = new ProfileService("root").loadRegistry();
    expect(reloaded.profiles[0]!.name).toBe("Renamed Root");
  });
});
