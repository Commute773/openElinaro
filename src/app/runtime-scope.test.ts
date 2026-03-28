import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRuntimeScope, type RuntimeScope } from "./runtime-scope";
import { telemetry } from "../services/infrastructure/telemetry";
import { updateTestRuntimeConfig } from "../test/runtime-config-test-helpers";

let tempRoot = "";
let previousCwd = "";
const previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
const previousUserDataDir = process.env.OPENELINARO_USER_DATA_DIR;

function writeRuntimeFixture() {
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".openelinarotest", "profiles/registry.json"),
    `${JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "root",
          name: "Root",
          roles: ["root"],
          memoryNamespace: "root",
          preferredProvider: "claude",
          defaultModelId: "claude-sonnet-4-20250514",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "projects"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".openelinarotest", "projects/registry.json"),
    `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`,
    "utf8",
  );
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "memory/documents/root"), { recursive: true });
}

function makeMinimalRoutines() {
  return {
    shouldRunHeartbeat: () => false,
    getTimezone: () => "UTC",
    getHeartbeatReminderSnapshot: () => ({
      currentLocalTime: "",
      timezone: "UTC",
      requiredCandidates: [],
      optionalCandidates: [],
      context: { mode: "interactive" },
      itemIds: [],
      occurrenceKeys: [],
    }),
    buildHeartbeatRequiredReminderMessage: () => "",
    markReminded: () => {},
    listItems: () => [],
    getItem: () => undefined,
    getProfileRoutines: () => [],
  } as any;
}

function makeMinimalConversationStore() {
  return {
    getConversation: () => undefined,
    createConversation: () => ({ key: "test", messages: [] }),
    saveConversation: () => {},
    listConversations: () => [],
  } as any;
}

function makeMinimalSystemPrompts() {
  return {
    buildSystemPrompt: () => "system prompt",
    buildConversationSystemPrompt: () => "system prompt",
  } as any;
}

function makeMinimalFinance() {
  return {
    getBalance: () => 0,
    recordUsage: () => {},
  } as any;
}

function makeMinimalHealth() {
  return {
    recordHealthEvent: () => {},
    getHealthStatus: () => ({ healthy: true }),
  } as any;
}

beforeEach(() => {
  previousCwd = process.cwd();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-scope-test-"));
  process.chdir(tempRoot);
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  process.env.OPENELINARO_USER_DATA_DIR = path.join(tempRoot, ".openelinarotest");
  writeRuntimeFixture();
  updateTestRuntimeConfig((config) => {
    config.core.app.automaticConversationMemoryEnabled = true;
  });
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
  if (previousUserDataDir === undefined) {
    delete process.env.OPENELINARO_USER_DATA_DIR;
  } else {
    process.env.OPENELINARO_USER_DATA_DIR = previousUserDataDir;
  }
});

function buildScope(overrides: { mode?: "interactive" | "subagent" } = {}): RuntimeScope {
  const { ProfileService } = require("../services/profile-service");
  const profiles = new ProfileService("root");
  const activeProfile = profiles.getProfile("root");

  return createRuntimeScope({
    profileId: "root",
    mode: overrides.mode ?? "interactive",
    appTelemetry: telemetry,
    profiles,
    activeProfile,
    routines: makeMinimalRoutines(),
    conversations: makeMinimalConversationStore(),
    systemPrompts: makeMinimalSystemPrompts(),
    finance: makeMinimalFinance(),
    health: makeMinimalHealth(),
    createSubagentController: () => ({
      launch: () => {},
      list: () => [],
    }),
  });
}

describe("createRuntimeScope", () => {
  test("returns a RuntimeScope with all expected properties", () => {
    const scope = buildScope();

    expect(scope.profile).toBeDefined();
    expect(scope.profile.id).toBe("root");
    expect(scope.access).toBeDefined();
    expect(scope.projects).toBeDefined();
    expect(scope.models).toBeDefined();
    expect(scope.memory).toBeDefined();
    expect(scope.conversationMemory).toBeDefined();
    expect(scope.reflection).toBeDefined();
    expect(scope.autonomousTime).toBeDefined();
    // connector was removed in the Pi migration; models resolve internally
    expect(scope.shell).toBeDefined();
    expect(scope.transitions).toBeDefined();
    expect(scope.routineTools).toBeDefined();
    expect(scope.toolResolver).toBeDefined();
    expect(scope.chat).toBeDefined();
  });

  test("returns exactly the RuntimeScope keys and no extras", () => {
    const scope = buildScope();
    const keys = Object.keys(scope).sort();
    const expected = [
      "access",
      "autonomousTime",
      "chat",
      "conversationMemory",
      "memory",
      "models",
      "profile",
      "projects",
      "reflection",
      "routineTools",
      "shell",
      "toolResolver",
      "transitions",
    ].sort();
    expect(keys).toEqual(expected);
  });

  test("works in subagent mode", () => {
    const scope = buildScope({ mode: "subagent" });
    expect(scope.profile.id).toBe("root");
    expect(scope.models).toBeDefined();
    expect(scope.chat).toBeDefined();
  });
});
