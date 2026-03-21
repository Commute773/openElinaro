import path from "node:path";
import { describe, expect, test } from "bun:test";
import { buildOpenElinaroCommandEnvironment } from "./shell-environment";

describe("buildOpenElinaroCommandEnvironment", () => {
  test("prepends the current Bun binary directory to PATH", () => {
    const env = buildOpenElinaroCommandEnvironment({
      PATH: "/usr/bin:/bin",
    });

    expect(env.PATH.split(path.delimiter)).toContain(path.dirname(process.execPath));
  });

  test("adds likely Bun install locations for shell-user profiles", () => {
    const env = buildOpenElinaroCommandEnvironment({
      OPENELINARO_PROFILE_SHELL_USER: "restricted",
      PATH: "/usr/bin:/bin",
    });

    expect(env.PATH.split(path.delimiter)).toContain("/Users/restricted/.bun/bin");
  });
});
