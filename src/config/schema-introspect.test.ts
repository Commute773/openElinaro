import { test, expect, describe } from "bun:test";
import { describeRuntimeConfigSchema } from "./schema-introspect";

describe("describeRuntimeConfigSchema", () => {
  test("root schema shows top-level keys", () => {
    const result = describeRuntimeConfigSchema();
    expect(result).toStartWith("(root): object {");
    expect(result).toContain("configVersion:");
    expect(result).toContain("core:");
    expect(result).toContain("calendar:");
    expect(result).toContain("email:");
    expect(result).toContain("finance:");
    expect(result).toContain("service:");
    expect(result).toEndWith("}");
  });

  test("nested object expands children with types", () => {
    const result = describeRuntimeConfigSchema("core.http");
    expect(result).toStartWith("core.http: object {");
    expect(result).toContain("host: string");
    expect(result).toContain("min_length: 1");
    expect(result).toContain("port: number");
    expect(result).toContain("int, positive");
    expect(result).toContain("default: 3000");
  });

  test("scalar leaf shows type, constraints, and default", () => {
    const result = describeRuntimeConfigSchema("core.http.port");
    expect(result).toBe("core.http.port: number (int, positive, default: 3000)");
  });

  test("string with min length and default", () => {
    const result = describeRuntimeConfigSchema("core.http.host");
    expect(result).toContain("string");
    expect(result).toContain("min_length: 1");
    expect(result).toContain('default: "0.0.0.0"');
  });

  test("boolean field with default", () => {
    const result = describeRuntimeConfigSchema("core.onboarding.bootstrapCompleted");
    expect(result).toContain("boolean");
    expect(result).toContain("default: false");
  });

  test("array type shows element schema inline", () => {
    const result = describeRuntimeConfigSchema("core.discord.guildIds");
    expect(result).toContain("array<string (min_length: 1)>");
    expect(result).toContain("default: []");
  });

  test("enum type shows possible values", () => {
    const result = describeRuntimeConfigSchema("communications.vonage.defaultMessageChannel");
    expect(result).toContain('"sms"');
    expect(result).toContain('"whatsapp"');
    expect(result).toContain('"messenger"');
    expect(result).toContain('default: "sms"');
  });

  test("bracket notation navigates into array element schema", () => {
    const result = describeRuntimeConfigSchema("finance.defaults.forecast.tax.federal_brackets_2025[0]");
    expect(result).toContain("[");
    expect(result).toContain("number");
    expect(result).toContain("null");
  });

  test("record type shows key and value types", () => {
    const result = describeRuntimeConfigSchema("finance.defaults.settings");
    expect(result).toContain("record<string, string>");
  });

  test("nonnegative constraint", () => {
    const result = describeRuntimeConfigSchema("configVersion");
    expect(result).toContain("nonnegative");
  });

  test("object children do not show verbose object defaults", () => {
    const result = describeRuntimeConfigSchema();
    // Top-level object children like "core" should not show "default: {...7 keys}"
    expect(result).not.toMatch(/core:.*default:/);
  });

  test("unknown key throws with available keys", () => {
    expect(() => describeRuntimeConfigSchema("core.nonexistent")).toThrow("Unknown key");
    expect(() => describeRuntimeConfigSchema("core.nonexistent")).toThrow("Available:");
  });

  test("cannot navigate into scalar", () => {
    expect(() => describeRuntimeConfigSchema("core.http.port.foo")).toThrow("Cannot navigate");
  });

  test("unmatched bracket throws", () => {
    expect(() => describeRuntimeConfigSchema("core.discord.guildIds[0")).toThrow("Unmatched '['");
  });

  test("empty path returns root", () => {
    const result = describeRuntimeConfigSchema("");
    expect(result).toStartWith("(root):");
  });

  test("undefined path returns root", () => {
    const result = describeRuntimeConfigSchema(undefined);
    expect(result).toStartWith("(root):");
  });

  test("whitespace-only path returns root", () => {
    const result = describeRuntimeConfigSchema("  ");
    expect(result).toStartWith("(root):");
  });

  test("deeply nested path works", () => {
    const result = describeRuntimeConfigSchema("core.app.cacheMissMonitor.maxCacheReadRatio");
    expect(result).toContain("number");
    expect(result).toContain("default: 0.2");
  });
});
