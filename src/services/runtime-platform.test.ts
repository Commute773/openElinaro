import { describe, expect, test } from "bun:test";
import { isRunningInsideManagedService, resolveRuntimePlatform } from "./runtime-platform";

describe("runtime platform", () => {
  test("resolves Darwin capabilities", () => {
    expect(resolveRuntimePlatform("darwin")).toEqual({
      os: "darwin",
      serviceManager: "launchd",
      managedServiceName: "com.openelinaro.bot",
      serviceStdoutLogFile: "service.stdout.log",
      serviceStderrLogFile: "service.stderr.log",
      supportsMedia: true,
    });
  });

  test("resolves Linux capabilities", () => {
    expect(resolveRuntimePlatform("linux")).toEqual({
      os: "linux",
      serviceManager: "systemd",
      managedServiceName: "openelinaro.service",
      serviceStdoutLogFile: "service.stdout.log",
      serviceStderrLogFile: "service.stderr.log",
      supportsMedia: false,
    });
  });

  test("detects managed-service execution from the environment", () => {
    expect(isRunningInsideManagedService({ OPENELINARO_SERVICE_ROOT_DIR: "/opt/openelinaro/app" })).toBe(true);
    expect(isRunningInsideManagedService({})).toBe(false);
  });

  test("rejects unsupported platforms", () => {
    expect(() => resolveRuntimePlatform("win32")).toThrow("Unsupported runtime platform");
  });
});
