import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ensureRuntimeConfigFile,
  reloadRuntimeConfig,
} from "../config/runtime-config";
import { updateTestRuntimeConfig } from "../test/runtime-config-test-helpers";
import {
  FEATURE_IDS,
  FeatureConfigService,
  parseFeatureValue,
  getFeatureConfigValue,
} from "./feature-config-service";

const tempDirs: string[] = [];
let previousUserDataDir: string | undefined;
let previousRootDir: string | undefined;

function withIsolatedRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-feat-test-"));
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

describe("FEATURE_IDS", () => {
  test("contains the expected features", () => {
    expect(FEATURE_IDS).toContain("calendar");
    expect(FEATURE_IDS).toContain("email");
    expect(FEATURE_IDS).toContain("communications");
    expect(FEATURE_IDS).toContain("webSearch");
    expect(FEATURE_IDS).toContain("webFetch");
    expect(FEATURE_IDS).toContain("openbrowser");
    expect(FEATURE_IDS).toContain("finance");
    expect(FEATURE_IDS).toContain("tickets");
    expect(FEATURE_IDS).toContain("localVoice");
    expect(FEATURE_IDS).toContain("media");
    expect(FEATURE_IDS.length).toBe(10);
  });
});

describe("FeatureConfigService", () => {
  test("listStatuses returns one status per feature", () => {
    withIsolatedRoot();
    ensureRuntimeConfigFile();
    const svc = new FeatureConfigService();
    const statuses = svc.listStatuses();
    expect(statuses.length).toBe(FEATURE_IDS.length);
    const ids = statuses.map((s) => s.featureId);
    for (const id of FEATURE_IDS) {
      expect(ids).toContain(id);
    }
  });

  test("all features have the expected status shape", () => {
    withIsolatedRoot();
    ensureRuntimeConfigFile();
    const svc = new FeatureConfigService();
    for (const status of svc.listStatuses()) {
      expect(typeof status.featureId).toBe("string");
      expect(typeof status.enabled).toBe("boolean");
      expect(typeof status.configured).toBe("boolean");
      expect(typeof status.active).toBe("boolean");
      expect(Array.isArray(status.missing)).toBe(true);
      expect(Array.isArray(status.notes)).toBe(true);
    }
  });

  describe("calendar", () => {
    test("disabled and not configured by default", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      const svc = new FeatureConfigService();
      const status = svc.getStatus("calendar");
      expect(status.enabled).toBe(false);
      expect(status.configured).toBe(false);
      expect(status.active).toBe(false);
      expect(status.missing).toContain("calendar.icsUrl");
    });

    test("configured when icsUrl is set", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      updateTestRuntimeConfig((c) => {
        c.calendar.enabled = true;
        c.calendar.icsUrl = "https://example.com/cal.ics";
      });
      const svc = new FeatureConfigService();
      const status = svc.getStatus("calendar");
      expect(status.enabled).toBe(true);
      expect(status.configured).toBe(true);
      expect(status.active).toBe(true);
      expect(status.missing).toEqual([]);
    });

    test("enabled but not active when icsUrl is blank", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      updateTestRuntimeConfig((c) => {
        c.calendar.enabled = true;
        c.calendar.icsUrl = "";
      });
      const svc = new FeatureConfigService();
      const status = svc.getStatus("calendar");
      expect(status.enabled).toBe(true);
      expect(status.configured).toBe(false);
      expect(status.active).toBe(false);
    });
  });

  describe("media", () => {
    test("disabled and not configured by default", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      const svc = new FeatureConfigService();
      const status = svc.getStatus("media");
      expect(status.enabled).toBe(false);
      expect(status.configured).toBe(false);
      expect(status.active).toBe(false);
      expect(status.missing).toContain("media.roots");
    });

    test("configured when roots are provided", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      updateTestRuntimeConfig((c) => {
        c.media.enabled = true;
        c.media.roots = ["/music"];
      });
      const svc = new FeatureConfigService();
      const status = svc.getStatus("media");
      expect(status.enabled).toBe(true);
      expect(status.configured).toBe(true);
      expect(status.active).toBe(true);
      expect(status.missing).toEqual([]);
    });
  });

  describe("finance", () => {
    test("enabled by default with configured paths", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      const svc = new FeatureConfigService();
      const status = svc.getStatus("finance");
      expect(status.enabled).toBe(true);
      expect(status.configured).toBe(true);
      expect(status.active).toBe(true);
      expect(status.missing).toEqual([]);
    });

    test("not configured when disabled", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      updateTestRuntimeConfig((c) => {
        c.finance.enabled = false;
      });
      const svc = new FeatureConfigService();
      const status = svc.getStatus("finance");
      expect(status.enabled).toBe(false);
      expect(status.configured).toBe(true);
      expect(status.active).toBe(false);
    });
  });

  describe("isActive", () => {
    test("returns false for disabled features", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      const svc = new FeatureConfigService();
      expect(svc.isActive("calendar")).toBe(false);
      expect(svc.isActive("email")).toBe(false);
      expect(svc.isActive("media")).toBe(false);
    });
  });

  describe("applyChanges", () => {
    test("toggles enabled flag", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      const svc = new FeatureConfigService();
      svc.applyChanges({ featureId: "calendar", enabled: true });
      const config = reloadRuntimeConfig();
      expect(config.calendar.enabled).toBe(true);
    });

    test("sets nested values", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      const svc = new FeatureConfigService();
      svc.applyChanges({
        featureId: "calendar",
        enabled: true,
        values: { icsUrl: "https://example.com/feed.ics" },
      });
      const config = reloadRuntimeConfig();
      expect(config.calendar.enabled).toBe(true);
      expect(config.calendar.icsUrl).toBe("https://example.com/feed.ics");
    });

    test("sets deeply nested values", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      const svc = new FeatureConfigService();
      svc.applyChanges({
        featureId: "localVoice",
        values: { "localLlm.model": "test-model" },
      });
      const config = reloadRuntimeConfig();
      expect(config.localVoice.localLlm.model).toBe("test-model");
    });
  });

  describe("renderStatusReport", () => {
    test("returns a multi-line report", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      const svc = new FeatureConfigService();
      const report = svc.renderStatusReport();
      expect(typeof report).toBe("string");
      const lines = report.split("\n");
      expect(lines.length).toBe(FEATURE_IDS.length);
      expect(report).toContain("calendar:");
      expect(report).toContain("finance:");
    });

    test("shows active features", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      const svc = new FeatureConfigService();
      const report = svc.renderStatusReport();
      expect(report).toContain("finance: active");
    });

    test("shows disabled features", () => {
      withIsolatedRoot();
      ensureRuntimeConfigFile();
      const svc = new FeatureConfigService();
      const report = svc.renderStatusReport();
      expect(report).toContain("calendar: disabled");
    });
  });
});

describe("parseFeatureValue", () => {
  test("returns empty string for empty input", () => {
    expect(parseFeatureValue("")).toBe("");
  });

  test("parses YAML booleans", () => {
    expect(parseFeatureValue("true")).toBe(true);
    expect(parseFeatureValue("false")).toBe(false);
  });

  test("parses YAML numbers", () => {
    expect(parseFeatureValue("42")).toBe(42);
    expect(parseFeatureValue("3.14")).toBe(3.14);
  });

  test("returns plain strings as-is", () => {
    expect(parseFeatureValue("hello")).toBe("hello");
  });

  test("parses YAML arrays", () => {
    const result = parseFeatureValue("[1, 2, 3]");
    expect(result).toEqual([1, 2, 3]);
  });

  test("parses YAML objects", () => {
    const result = parseFeatureValue("{a: 1, b: 2}");
    expect(result).toEqual({ a: 1, b: 2 });
  });
});

describe("getFeatureConfigValue", () => {
  test("delegates to getRuntimeConfigValue", () => {
    withIsolatedRoot();
    ensureRuntimeConfigFile();
    expect(getFeatureConfigValue("core.http.port")).toBe(3000);
    expect(getFeatureConfigValue("calendar.enabled")).toBe(false);
  });
});
