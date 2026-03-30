import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import {
  ensureRuntimeConfigFile,
  formatRuntimeConfigValidationError,
  getRuntimeConfig,
  getRuntimeConfigPath,
  getRuntimeConfigValue,
  hasRuntimeConfigPath,
  reloadRuntimeConfig,
  RuntimeConfigSchema,
  saveRuntimeConfig,
  setRuntimeConfigValue,
  unsetRuntimeConfigValue,
  validateRuntimeConfig,
  validateRuntimeConfigFile,
  validateRuntimeConfigText,
} from "./runtime-config";

const tempDirs: string[] = [];
let previousUserDataDir: string | undefined;
let previousRootDir: string | undefined;

function withIsolatedRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-rtcfg-test-"));
  tempDirs.push(dir);
  process.env.OPENELINARO_USER_DATA_DIR = dir;
  process.env.OPENELINARO_ROOT_DIR = dir;
  return dir;
}

beforeEach(() => {
  previousUserDataDir = process.env.OPENELINARO_USER_DATA_DIR;
  previousRootDir = process.env.OPENELINARO_ROOT_DIR;
});

afterEach(() => {
  if (previousUserDataDir === undefined) {
    delete process.env.OPENELINARO_USER_DATA_DIR;
  } else {
    process.env.OPENELINARO_USER_DATA_DIR = previousUserDataDir;
  }
  if (previousRootDir === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDir;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("RuntimeConfigSchema", () => {
  test("parses an empty object and applies all defaults", () => {
    const config = RuntimeConfigSchema.parse({});
    expect(config.core.profile.activeProfileId).toBe("root");
    expect(config.core.assistant.displayName).toBe("OpenElinaro");
    expect(config.core.discord.guildIds).toEqual([]);
    expect(config.core.onboarding.bootstrapCompleted).toBe(false);
    expect(config.core.http.port).toBe(3000);
    expect(config.core.http.host).toBe("0.0.0.0");
    expect(config.core.app.automaticConversationMemoryEnabled).toBe(true);
    expect(config.core.app.docsIndexerEnabled).toBe(false);
    expect(config.calendar.enabled).toBe(false);
    expect(config.email.enabled).toBe(false);
    expect(config.email.imapPort).toBe(993);
    expect(config.communications.enabled).toBe(false);
    expect(config.webSearch.enabled).toBe(false);
    expect(config.webFetch.enabled).toBe(false);
    expect(config.openbrowser.enabled).toBe(false);
    expect(config.finance.enabled).toBe(true);
    expect(config.tickets.enabled).toBe(false);
    expect(config.localVoice.enabled).toBe(false);
    expect(config.media.enabled).toBe(false);
    expect(config.media.roots).toEqual([]);
    expect(config.autonomousTime.enabled).toBe(false);
    expect(config.autonomousTime.promptPath).toBe("assistant_context/autonomous-time.md");
    expect(config.models.extendedContext["openai-codex/gpt-5.4"]?.extendedContextWindow).toBe(1_050_000);
  });

  test("preserves explicit overrides alongside defaults", () => {
    const config = RuntimeConfigSchema.parse({
      core: { http: { port: 4000 } },
      calendar: { enabled: true, icsUrl: "https://example.com/cal.ics" },
    });
    expect(config.core.http.port).toBe(4000);
    expect(config.core.http.host).toBe("0.0.0.0");
    expect(config.calendar.enabled).toBe(true);
    expect(config.calendar.icsUrl).toBe("https://example.com/cal.ics");
    expect(config.email.enabled).toBe(false);
    expect(config.autonomousTime.enabled).toBe(false);
  });

  test("rejects invalid values", () => {
    expect(() => RuntimeConfigSchema.parse({ core: { http: { port: -1 } } })).toThrow();
    expect(() => RuntimeConfigSchema.parse({ core: { http: { port: "abc" } } })).toThrow();
    expect(() => RuntimeConfigSchema.parse({ email: { imapPort: 0 } })).toThrow();
  });

  test("applies instance defaults", () => {
    const config = RuntimeConfigSchema.parse({});
    expect(config.core.app.instance.socketPath).toBe("");
    expect(config.core.app.instance.peers).toEqual([]);
  });

  test("applies cache miss monitor defaults", () => {
    const config = RuntimeConfigSchema.parse({});
    expect(config.core.app.cacheMissMonitor.minInputTokens).toBe(30_000);
    expect(config.core.app.cacheMissMonitor.minMissTokens).toBe(20_000);
    expect(config.core.app.cacheMissMonitor.maxCacheReadRatio).toBe(0.2);
    expect(config.core.app.cacheMissMonitor.discordCooldownMs).toBe(15 * 60 * 1_000);
  });

  test("applies models.extendedContext defaults", () => {
    const config = RuntimeConfigSchema.parse({});
    expect(config.models.extendedContext).toEqual({
      "openai-codex/gpt-5.4": { extendedContextWindow: 1_050_000 },
    });
  });

  test("preserves custom extended context overrides", () => {
    const config = RuntimeConfigSchema.parse({
      models: {
        extendedContext: {
          "openai-codex/gpt-5.4": { extendedContextWindow: 500_000 },
          "claude/claude-opus-4-6": { extendedContextWindow: 1_000_000 },
        },
      },
    });
    expect(config.models.extendedContext["openai-codex/gpt-5.4"]?.extendedContextWindow).toBe(500_000);
    expect(config.models.extendedContext["claude/claude-opus-4-6"]?.extendedContextWindow).toBe(1_000_000);
  });

  test("accepts an empty extendedContext map", () => {
    const config = RuntimeConfigSchema.parse({
      models: { extendedContext: {} },
    });
    expect(config.models.extendedContext).toEqual({});
  });

  test("rejects invalid extendedContextWindow values", () => {
    expect(() => RuntimeConfigSchema.parse({
      models: { extendedContext: { "test/model": { extendedContextWindow: -1 } } },
    })).toThrow();
    expect(() => RuntimeConfigSchema.parse({
      models: { extendedContext: { "test/model": { extendedContextWindow: 0 } } },
    })).toThrow();
  });
});

describe("validateRuntimeConfig", () => {
  test("returns a valid config from a plain object", () => {
    const config = validateRuntimeConfig({});
    expect(config.core.profile.activeProfileId).toBe("root");
  });

  test("throws on invalid input", () => {
    expect(() => validateRuntimeConfig({ core: { http: { port: "bad" } } })).toThrow();
  });
});

describe("validateRuntimeConfigText", () => {
  test("parses YAML text into a validated config", () => {
    const yaml = stringify({ core: { http: { port: 5000 } } });
    const config = validateRuntimeConfigText(yaml);
    expect(config.core.http.port).toBe(5000);
  });

  test("treats empty or whitespace text as empty config", () => {
    const config = validateRuntimeConfigText("   ");
    expect(config.core.profile.activeProfileId).toBe("root");
  });

  test("treats fully empty string as empty config", () => {
    const config = validateRuntimeConfigText("");
    expect(config.core.profile.activeProfileId).toBe("root");
  });
});

describe("formatRuntimeConfigValidationError", () => {
  test("formats ZodError with paths", () => {
    try {
      RuntimeConfigSchema.parse({ core: { http: { port: "bad" } } });
    } catch (err) {
      const msg = formatRuntimeConfigValidationError(err);
      expect(msg).toContain("core.http.port");
    }
  });

  test("formats plain Error", () => {
    const msg = formatRuntimeConfigValidationError(new Error("boom"));
    expect(msg).toBe("boom");
  });

  test("formats non-error values", () => {
    const msg = formatRuntimeConfigValidationError(42);
    expect(msg).toBe("42");
  });
});

describe("file operations", () => {
  test("ensureRuntimeConfigFile creates the config file if it does not exist", () => {
    withIsolatedRoot();
    const configPath = ensureRuntimeConfigFile();
    expect(fs.existsSync(configPath)).toBe(true);
    const text = fs.readFileSync(configPath, "utf8");
    const config = validateRuntimeConfigText(text);
    expect(config.core.profile.activeProfileId).toBe("root");
  });

  test("ensureRuntimeConfigFile returns existing file path without overwriting", () => {
    withIsolatedRoot();
    const configPath = ensureRuntimeConfigFile();
    const customYaml = stringify({ core: { http: { port: 9999 } } });
    fs.writeFileSync(configPath, customYaml);

    const returned = ensureRuntimeConfigFile();
    expect(returned).toBe(configPath);
    const text = fs.readFileSync(returned, "utf8");
    expect(text).toBe(customYaml);
  });

  test("validateRuntimeConfigFile reads and validates a file", () => {
    withIsolatedRoot();
    const configPath = ensureRuntimeConfigFile();
    const config = validateRuntimeConfigFile(configPath);
    expect(config.core.profile.activeProfileId).toBe("root");
  });

  test("getRuntimeConfig returns cached config", () => {
    withIsolatedRoot();
    const a = getRuntimeConfig();
    const b = getRuntimeConfig();
    expect(a).toEqual(b);
  });

  test("reloadRuntimeConfig reads fresh from disk", () => {
    withIsolatedRoot();
    const original = getRuntimeConfig();
    expect(original.core.http.port).toBe(3000);

    const configPath = getRuntimeConfigPath();
    const modified = { ...original, core: { ...original.core, http: { ...original.core.http, port: 7777 } } };
    fs.writeFileSync(configPath, stringify(modified));

    const reloaded = reloadRuntimeConfig();
    expect(reloaded.core.http.port).toBe(7777);
  });

  test("saveRuntimeConfig writes validated config to disk", () => {
    withIsolatedRoot();
    const config = getRuntimeConfig();
    const updated = structuredClone(config);
    updated.core.http.port = 8888;

    saveRuntimeConfig(updated);

    const reloaded = reloadRuntimeConfig();
    expect(reloaded.core.http.port).toBe(8888);
  });

  test("saveRuntimeConfig validates before writing", () => {
    withIsolatedRoot();
    getRuntimeConfig();
    const bad = { core: { http: { port: -1 } } } as any;
    expect(() => saveRuntimeConfig(bad)).toThrow();
  });
});

describe("hasRuntimeConfigPath", () => {
  test("returns true for valid top-level paths", () => {
    expect(hasRuntimeConfigPath("core")).toBe(true);
    expect(hasRuntimeConfigPath("calendar")).toBe(true);
    expect(hasRuntimeConfigPath("email")).toBe(true);
    expect(hasRuntimeConfigPath("media")).toBe(true);
    expect(hasRuntimeConfigPath("autonomousTime")).toBe(true);
  });

  test("returns true for nested paths", () => {
    expect(hasRuntimeConfigPath("core.http.port")).toBe(true);
    expect(hasRuntimeConfigPath("core.profile.activeProfileId")).toBe(true);
    expect(hasRuntimeConfigPath("calendar.enabled")).toBe(true);
    expect(hasRuntimeConfigPath("autonomousTime.promptPath")).toBe(true);
  });

  test("returns false for nonexistent paths", () => {
    expect(hasRuntimeConfigPath("nonexistent")).toBe(false);
    expect(hasRuntimeConfigPath("core.nonexistent")).toBe(false);
    expect(hasRuntimeConfigPath("core.http.nonexistent")).toBe(false);
  });

  test("returns false for empty path", () => {
    expect(hasRuntimeConfigPath("")).toBe(false);
  });
});

describe("getRuntimeConfigValue", () => {
  test("retrieves nested config values", () => {
    withIsolatedRoot();
    getRuntimeConfig();
    expect(getRuntimeConfigValue("core.http.port")).toBe(3000);
    expect(getRuntimeConfigValue("core.profile.activeProfileId")).toBe("root");
    expect(getRuntimeConfigValue("calendar.enabled")).toBe(false);
  });

  test("returns undefined for nonexistent paths", () => {
    withIsolatedRoot();
    getRuntimeConfig();
    expect(getRuntimeConfigValue("nonexistent")).toBeUndefined();
    expect(getRuntimeConfigValue("core.nonexistent")).toBeUndefined();
  });

  test("returns an object for intermediate paths", () => {
    withIsolatedRoot();
    getRuntimeConfig();
    const http = getRuntimeConfigValue("core.http") as Record<string, unknown>;
    expect(http.port).toBe(3000);
    expect(http.host).toBe("0.0.0.0");
  });
});

describe("setRuntimeConfigValue", () => {
  test("sets a nested value and persists it", () => {
    withIsolatedRoot();
    getRuntimeConfig();
    setRuntimeConfigValue("core.http.port", 4444);
    const reloaded = reloadRuntimeConfig();
    expect(reloaded.core.http.port).toBe(4444);
  });

  test("throws on empty path", () => {
    withIsolatedRoot();
    getRuntimeConfig();
    expect(() => setRuntimeConfigValue("", "value")).toThrow("Config path cannot be empty");
  });

  test("validates after setting", () => {
    withIsolatedRoot();
    getRuntimeConfig();
    expect(() => setRuntimeConfigValue("core.http.port", -1)).toThrow();
  });
});

describe("unsetRuntimeConfigValue", () => {
  test("removes a value and lets the default fill in on reload", () => {
    withIsolatedRoot();
    setRuntimeConfigValue("core.http.port", 5555);
    expect(getRuntimeConfigValue("core.http.port")).toBe(5555);

    unsetRuntimeConfigValue("core.http.port");
    const reloaded = reloadRuntimeConfig();
    expect(reloaded.core.http.port).toBe(3000);
  });

  test("throws on empty path", () => {
    withIsolatedRoot();
    getRuntimeConfig();
    expect(() => unsetRuntimeConfigValue("")).toThrow("Config path cannot be empty");
  });

  test("is a no-op for nonexistent intermediate paths", () => {
    withIsolatedRoot();
    const before = getRuntimeConfig();
    unsetRuntimeConfigValue("nonexistent.deep.path");
    const after = getRuntimeConfig();
    expect(after).toEqual(before);
  });
});
