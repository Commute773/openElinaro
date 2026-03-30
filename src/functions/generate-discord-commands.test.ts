import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { generateDiscordCommand, generateDiscordCommands, type DiscordCommandDescriptor } from "./generate-discord-commands";
import type { FunctionDefinition } from "./define-function";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDef(overrides: Partial<FunctionDefinition> & { name: string; input: z.ZodType }): FunctionDefinition {
  return {
    description: `Description for ${overrides.name}`,
    handler: async () => "ok",
    format: (r: unknown) => String(r),
    auth: { access: "anyone", behavior: "uniform" },
    domains: ["test"],
    agentScopes: ["chat"],
    ...overrides,
  } as FunctionDefinition;
}

// ---------------------------------------------------------------------------
// Tests: canAutoGenerateOptions (via generateDiscordCommand behavior)
// ---------------------------------------------------------------------------

describe("canAutoGenerateOptions", () => {
  test("simple schema with primitive fields produces typed options", () => {
    const def = makeDef({
      name: "greet",
      input: z.object({
        name: z.string(),
        loud: z.boolean().optional(),
      }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options.length).toBe(2);
    expect(cmd.options[0]!.name).toBe("name");
    expect(cmd.options[0]!.type).toBe("string");
    expect(cmd.options[0]!.required).toBe(true);
    expect(cmd.options[1]!.name).toBe("loud");
    expect(cmd.options[1]!.type).toBe("boolean");
    expect(cmd.options[1]!.required).toBe(false);
  });

  test("complex schema (nested object) falls back to generic JSON input option", () => {
    const def = makeDef({
      name: "complex",
      input: z.object({
        config: z.object({ host: z.string(), port: z.number() }),
      }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options.length).toBe(1);
    expect(cmd.options[0]!.name).toBe("input");
    expect(cmd.options[0]!.type).toBe("string");
    expect(cmd.options[0]!.required).toBe(false);
  });

  test("schema with more than 5 fields falls back to generic JSON input option", () => {
    const def = makeDef({
      name: "many_fields",
      input: z.object({
        a: z.string(),
        b: z.string(),
        c: z.string(),
        d: z.string(),
        e: z.string(),
        f: z.string(),
      }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options.length).toBe(1);
    expect(cmd.options[0]!.name).toBe("input");
  });

  test("empty object schema produces no options", () => {
    const def = makeDef({
      name: "no_args",
      input: z.object({}),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Zod type to Discord option type mapping
// ---------------------------------------------------------------------------

describe("zodToDiscordType mapping", () => {
  test("z.string maps to 'string'", () => {
    const def = makeDef({ name: "str", input: z.object({ val: z.string() }) });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.type).toBe("string");
  });

  test("z.number maps to 'number'", () => {
    const def = makeDef({ name: "num", input: z.object({ val: z.number() }) });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.type).toBe("number");
  });

  test("z.number().int() maps to 'number' (Zod 4 changed int check format)", () => {
    // In Zod 4, .int() uses format: "safeint" instead of kind: "int",
    // so zodToDiscordType does not detect integer — this is a known limitation.
    const def = makeDef({ name: "int_num", input: z.object({ val: z.number().int() }) });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.type).toBe("number");
  });

  test("z.boolean maps to 'boolean'", () => {
    const def = makeDef({ name: "bool", input: z.object({ val: z.boolean() }) });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.type).toBe("boolean");
  });

  test("z.enum maps to 'string' with choices", () => {
    const def = makeDef({
      name: "with_enum",
      input: z.object({ status: z.enum(["on", "off", "standby"]) }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.type).toBe("string");
    expect(cmd.options[0]!.choices).toEqual([
      { name: "on", value: "on" },
      { name: "off", value: "off" },
      { name: "standby", value: "standby" },
    ]);
  });

  test("optional enum preserves choices", () => {
    const def = makeDef({
      name: "opt_enum",
      input: z.object({ mode: z.enum(["fast", "slow"]).optional() }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.required).toBe(false);
    expect(cmd.options[0]!.choices).toEqual([
      { name: "fast", value: "fast" },
      { name: "slow", value: "slow" },
    ]);
  });

  test("z.default unwraps to inner type", () => {
    const def = makeDef({
      name: "with_default",
      input: z.object({ count: z.number().default(5) }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.type).toBe("number");
    expect(cmd.options[0]!.required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: command name and description generation
// ---------------------------------------------------------------------------

describe("command name and description", () => {
  test("uses function name as command name", () => {
    const def = makeDef({ name: "my_command", input: z.object({}) });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.name).toBe("my_command");
  });

  test("uses function description by default", () => {
    const def = makeDef({
      name: "cmd",
      description: "Does something great",
      input: z.object({}),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.description).toBe("Does something great");
  });

  test("uses discord annotation description when provided", () => {
    const def = makeDef({
      name: "cmd",
      description: "Function description",
      input: z.object({}),
      discord: { description: "Discord-specific description" },
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.description).toBe("Discord-specific description");
  });

  test("truncates description to 100 characters", () => {
    const longDesc = "A".repeat(150);
    const def = makeDef({
      name: "long",
      description: longDesc,
      input: z.object({}),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.description.length).toBe(100);
  });

  test("preserves custom inputMapper from discord annotation", () => {
    const mapper = (interaction: unknown) => ({ mapped: true });
    const def = makeDef({
      name: "mapped",
      input: z.object({}),
      discord: { inputMapper: mapper },
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.inputMapper).toBe(mapper);
  });
});

// ---------------------------------------------------------------------------
// Tests: surface filtering
// ---------------------------------------------------------------------------

describe("surface filtering", () => {
  test("returns null when discord surface is excluded", () => {
    const def = makeDef({
      name: "api_only",
      input: z.object({}),
      surfaces: ["api"],
    });
    const cmd = generateDiscordCommand(def);
    expect(cmd).toBeNull();
  });

  test("generates command when discord surface is included", () => {
    const def = makeDef({
      name: "discord_cmd",
      input: z.object({}),
      surfaces: ["discord"],
    });
    const cmd = generateDiscordCommand(def);
    expect(cmd).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: generateDiscordCommands (bulk)
// ---------------------------------------------------------------------------

describe("generateDiscordCommands", () => {
  test("generates commands for all discord-surface definitions", () => {
    const defs = [
      makeDef({ name: "cmd_a", input: z.object({}), surfaces: ["discord"] }),
      makeDef({ name: "cmd_b", input: z.object({}), surfaces: ["api"] }),
      makeDef({ name: "cmd_c", input: z.object({}) }), // default = all surfaces
    ];
    const cmds = generateDiscordCommands(defs);
    expect(cmds.length).toBe(2);
    expect(cmds.map((c) => c.name)).toEqual(["cmd_a", "cmd_c"]);
  });

  test("respects feature gating", () => {
    const defs = [
      makeDef({ name: "gated_cmd", input: z.object({}), featureGate: "finance" as any }),
      makeDef({ name: "open_cmd", input: z.object({}) }),
    ];
    const cmds = generateDiscordCommands(defs, (id) => id !== "finance");
    expect(cmds.length).toBe(1);
    expect(cmds[0]!.name).toBe("open_cmd");
  });
});

// ---------------------------------------------------------------------------
// Edge case: enum with more than 25 values (Discord limit)
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("enum choices are limited to 25 entries", () => {
    const values = Array.from({ length: 30 }, (_, i) => `val_${i}`) as [string, ...string[]];
    const def = makeDef({
      name: "big_enum",
      input: z.object({ pick: z.enum(values) }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.choices!.length).toBe(25);
  });
});
