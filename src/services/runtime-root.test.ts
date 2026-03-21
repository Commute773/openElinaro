import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getUserDataRootDir } from "./runtime-root";

let previousUserDataRootDir: string | undefined;
let previousRootDir: string | undefined;
let previousNodeEnv: string | undefined;

beforeEach(() => {
  previousUserDataRootDir = process.env.OPENELINARO_USER_DATA_DIR;
  previousRootDir = process.env.OPENELINARO_ROOT_DIR;
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
});
