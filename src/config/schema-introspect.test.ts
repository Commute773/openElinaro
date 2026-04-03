import { test, expect, describe } from "bun:test";
import { z } from "zod";
import {
  parsePathSegments,
  analyze,
  resolveSchemaAtPath,
  describeRuntimeConfigSchema,
} from "./schema-introspect";

// ---------------------------------------------------------------------------
// parsePathSegments
// ---------------------------------------------------------------------------

describe("parsePathSegments", () => {
  test("simple dotted path", () => {
    expect(parsePathSegments("foo.bar.baz")).toEqual(["foo", "bar", "baz"]);
  });

  test("bracket notation", () => {
    expect(parsePathSegments("items[0].name")).toEqual(["items", "[0]", "name"]);
  });

  test("mixed dot and bracket", () => {
    expect(parsePathSegments("a.b[2].c[0]")).toEqual(["a", "b", "[2]", "c", "[0]"]);
  });

  test("empty path returns empty array", () => {
    expect(parsePathSegments("")).toEqual([]);
  });

  test("whitespace-only returns empty array", () => {
    expect(parsePathSegments("   ")).toEqual([]);
  });

  test("single segment", () => {
    expect(parsePathSegments("foo")).toEqual(["foo"]);
  });

  test("bracket at start", () => {
    expect(parsePathSegments("[0].name")).toEqual(["[0]", "name"]);
  });

  test("consecutive brackets", () => {
    expect(parsePathSegments("[0][1]")).toEqual(["[0]", "[1]"]);
  });

  test("throws on unmatched bracket", () => {
    expect(() => parsePathSegments("foo[0")).toThrow("Unmatched '['");
  });

  test("trims whitespace", () => {
    expect(parsePathSegments("  foo.bar  ")).toEqual(["foo", "bar"]);
  });
});

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

describe("analyze", () => {
  test("plain string schema", () => {
    const result = analyze(z.string());
    expect(result.optional).toBe(false);
    expect(result.nullable).toBe(false);
    expect(result.hasDefault).toBe(false);
    expect(result.inner).toBeInstanceOf(z.ZodString);
  });

  test("optional string schema", () => {
    const result = analyze(z.string().optional());
    expect(result.optional).toBe(true);
    expect(result.nullable).toBe(false);
    expect(result.hasDefault).toBe(false);
    expect(result.inner).toBeInstanceOf(z.ZodString);
  });

  test("nullable string schema", () => {
    const result = analyze(z.string().nullable());
    expect(result.nullable).toBe(true);
    expect(result.optional).toBe(false);
    expect(result.inner).toBeInstanceOf(z.ZodString);
  });

  test("schema with default value", () => {
    const result = analyze(z.number().default(42));
    expect(result.hasDefault).toBe(true);
    // defaultValue is a function in Zod v4, so call it
    const defaultVal = typeof result.defaultValue === "function"
      ? result.defaultValue()
      : result.defaultValue;
    expect(defaultVal).toBe(42);
    expect(result.inner).toBeInstanceOf(z.ZodNumber);
  });

  test("nullable optional with default", () => {
    const result = analyze(z.string().nullable().optional().default(null));
    expect(result.hasDefault).toBe(true);
    expect(result.optional).toBe(true);
    expect(result.nullable).toBe(true);
    expect(result.inner).toBeInstanceOf(z.ZodString);
  });

  test("nested object schema", () => {
    const schema = z.object({ name: z.string() });
    const result = analyze(schema);
    expect(result.inner).toBeInstanceOf(z.ZodObject);
    expect(result.optional).toBe(false);
  });

  test("array schema", () => {
    const result = analyze(z.array(z.number()));
    expect(result.inner).toBeInstanceOf(z.ZodArray);
  });
});

// ---------------------------------------------------------------------------
// resolveSchemaAtPath — with a test schema
// ---------------------------------------------------------------------------

describe("resolveSchemaAtPath", () => {
  const TestSchema = z.object({
    name: z.string().default("test"),
    settings: z.object({
      enabled: z.boolean().default(false),
      nested: z.object({
        deep: z.number().int().default(0),
      }).default({ deep: 0 }),
    }).default({ enabled: false, nested: { deep: 0 } }),
    tags: z.array(z.string()).default([]),
    counts: z.record(z.string(), z.number()),
  });

  test("navigates to a top-level key", () => {
    const schema = resolveSchemaAtPath(TestSchema, "name");
    // After unwrapping defaults, should be a string
    const meta = analyze(schema);
    expect(meta.inner).toBeInstanceOf(z.ZodString);
  });

  test("navigates to a nested key", () => {
    const schema = resolveSchemaAtPath(TestSchema, "settings.enabled");
    const meta = analyze(schema);
    expect(meta.inner).toBeInstanceOf(z.ZodBoolean);
  });

  test("navigates deeply nested keys", () => {
    const schema = resolveSchemaAtPath(TestSchema, "settings.nested.deep");
    const meta = analyze(schema);
    expect(meta.inner).toBeInstanceOf(z.ZodNumber);
  });

  test("navigates into an array with bracket notation", () => {
    const schema = resolveSchemaAtPath(TestSchema, "tags[0]");
    const meta = analyze(schema);
    expect(meta.inner).toBeInstanceOf(z.ZodString);
  });

  test("navigates into a record value", () => {
    const schema = resolveSchemaAtPath(TestSchema, "counts.anyKey");
    const meta = analyze(schema);
    expect(meta.inner).toBeInstanceOf(z.ZodNumber);
  });

  test("throws on invalid key", () => {
    expect(() => resolveSchemaAtPath(TestSchema, "nonexistent")).toThrow('Unknown key "nonexistent"');
  });

  test("throws when indexing a non-array", () => {
    expect(() => resolveSchemaAtPath(TestSchema, "name[0]")).toThrow("Cannot index");
  });
});

// ---------------------------------------------------------------------------
// describeRuntimeConfigSchema — integration with real RuntimeConfigSchema
// ---------------------------------------------------------------------------

describe("describeRuntimeConfigSchema", () => {
  test("root path returns object description with top-level keys", () => {
    const desc = describeRuntimeConfigSchema();
    expect(desc).toContain("(root)");
    expect(desc).toContain("configVersion");
    expect(desc).toContain("core");
    expect(desc).toContain("email");
  });

  test("scalar path returns type description", () => {
    const desc = describeRuntimeConfigSchema("core.http.port");
    expect(desc).toContain("core.http.port");
    expect(desc).toContain("number");
  });

  test("object path returns expanded children", () => {
    const desc = describeRuntimeConfigSchema("core.http");
    expect(desc).toContain("core.http");
    expect(desc).toContain("host");
    expect(desc).toContain("port");
    expect(desc).toContain("apiKey");
  });

  test("array path with bracket notation resolves element type", () => {
    const desc = describeRuntimeConfigSchema("core.discord.guildIds[0]");
    expect(desc).toContain("string");
  });

  test("throws for invalid path", () => {
    expect(() => describeRuntimeConfigSchema("core.nonexistent")).toThrow();
  });

  test("nested path through defaults works", () => {
    const desc = describeRuntimeConfigSchema("core.app.cacheMissMonitor.maxCacheReadRatio");
    expect(desc).toContain("number");
  });

  test("enum field describes values", () => {
    const desc = describeRuntimeConfigSchema("communications.vonage.defaultMessageChannel");
    // Should contain some of the enum values
    expect(desc).toContain("sms");
    expect(desc).toContain("whatsapp");
  });

  test("boolean field", () => {
    const desc = describeRuntimeConfigSchema("core.onboarding.bootstrapCompleted");
    expect(desc).toContain("boolean");
  });

  test("record field describes key/value types", () => {
    const desc = describeRuntimeConfigSchema("models.extendedContext");
    expect(desc).toContain("record");
  });
});
