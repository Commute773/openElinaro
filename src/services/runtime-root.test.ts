import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getServiceRootDir, getUserDataRootDir } from "./runtime-root";

let previousUserDataRootDir: string | undefined;
let previousRootDir: string | undefined;
let previousServiceRootDir: string | undefined;
let previousNodeEnv: string | undefined;

beforeEach(() => {
  previousUserDataRootDir = process.env.OPENELINARO_USER_DATA_DIR;
  previousRootDir = process.env.OPENELINARO_ROOT_DIR;
  previousServiceRootDir = process.env.OPENELINARO_SERVICE_ROOT_DIR;
  previousNodeEnv = process.env.NODE_ENV;
});

afterEach(() => {
  if (previousUserDataRootDir === undefined) {
    delete process.env.OPENELINARO_USER_DATA_DIR;
  } else {
    process.env.OPENELINARO_USER_DATA_DIR = previousUserDataRootDir;
  }
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
  if (previousNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previousNodeEnv;
  }
});

describe("runtime-root", () => {
  test("defaults the live user data root to the home directory", () => {
    delete process.env.OPENELINARO_USER_DATA_DIR;
    process.env.OPENELINARO_ROOT_DIR = "/tmp/openelinaro-repo-root";
    delete process.env.NODE_ENV;

    expect(getUserDataRootDir()).toBe(path.join(os.homedir(), ".openelinaro"));
  });

  test("defaults the test user data root to the home directory when no isolated runtime root is set", () => {
    delete process.env.OPENELINARO_USER_DATA_DIR;
    delete process.env.OPENELINARO_ROOT_DIR;
    process.env.NODE_ENV = "test";

    expect(getUserDataRootDir()).toBe(path.join(os.homedir(), ".openelinarotest"));
  });

  test("keeps test user data rooted under the isolated runtime root", () => {
    delete process.env.OPENELINARO_USER_DATA_DIR;
    process.env.OPENELINARO_ROOT_DIR = "/tmp/openelinaro-test-root";
    process.env.NODE_ENV = "test";

    expect(getUserDataRootDir()).toBe("/tmp/openelinaro-test-root/.openelinarotest");
  });

  test("keeps bundled service assets rooted in the code checkout when runtime root is isolated", () => {
    delete process.env.OPENELINARO_SERVICE_ROOT_DIR;
    process.env.OPENELINARO_ROOT_DIR = "/tmp/openelinaro-test-root";
    process.env.NODE_ENV = "test";

    const serviceRoot = getServiceRootDir();
    expect(serviceRoot).not.toBe("/tmp/openelinaro-test-root");
    expect(fs.existsSync(path.join(serviceRoot, "profiles/registry.json"))).toBe(true);
  });

  test("prefers OPENELINARO_SERVICE_ROOT_DIR when explicitly configured", () => {
    process.env.OPENELINARO_SERVICE_ROOT_DIR = "/tmp/openelinaro-service-root";
    process.env.OPENELINARO_ROOT_DIR = "/tmp/openelinaro-runtime-root";

    expect(getServiceRootDir()).toBe("/tmp/openelinaro-service-root");
  });
});
