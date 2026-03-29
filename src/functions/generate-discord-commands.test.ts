import { test, expect, describe } from "bun:test";
import { z } from "zod";
import {
  generateDiscordCommand,
  generateDiscordCommands,
} from "./generate-discord-commands";
import type { FunctionDefinition } from "./define-function";
import { formatResult } from "./formatters";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal function definition with sensible defaults. */
function makeDef(
  overrides: Partial<FunctionDefinition> & { name: string; input: z.ZodType },
): FunctionDefinition {
  return {
    description: "test function",
    handler: async () => ({}),
    format: formatResult,
    auth: { access: "self", behavior: "allow" },
    domains: ["test"],
    agentScopes: ["foreground"],
    ...overrides,
  } as FunctionDefinition;
}

// ---------------------------------------------------------------------------
// Auto-option generation from simple Zod schemas
// ---------------------------------------------------------------------------

describe("generateDiscordCommand — auto-option generation", () => {
  test("string field becomes a string option", () => {
    const def = makeDef({
      name: "greet",
      input: z.object({ message: z.string() }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd).not.toBeNull();
    expect(cmd.options).toHaveLength(1);
    expect(cmd.options[0]!).toEqual({
      name: "message",
      description: "message",
      type: "string",
      required: true,
      choices: undefined,
    });
  });

  test("number field becomes a number option", () => {
    const def = makeDef({
      name: "set-count",
      input: z.object({ count: z.number() }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.type).toBe("number");
  });

  test("z.number().int() maps to number (int detection relies on kind=int check)", () => {
    // The current implementation looks for checks with kind === "int",
    // but Zod v3.24+ uses isInt: true instead. This test documents
    // actual behavior: .int() falls through to "number".
    const def = makeDef({
      name: "set-count",
      input: z.object({ count: z.number().int() }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.type).toBe("number");
  });

  test("boolean field becomes a boolean option", () => {
    const def = makeDef({
      name: "toggle",
      input: z.object({ enabled: z.boolean() }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.type).toBe("boolean");
  });

  test("enum field becomes a string option with choices", () => {
    const def = makeDef({
      name: "pick-color",
      input: z.object({ color: z.enum(["red", "green", "blue"]) }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.type).toBe("string");
    expect(cmd.options[0]!.choices).toEqual([
      { name: "red", value: "red" },
      { name: "green", value: "green" },
      { name: "blue", value: "blue" },
    ]);
  });

  test("multiple primitive fields all become options", () => {
    const def = makeDef({
      name: "multi",
      input: z.object({
        name: z.string(),
        age: z.number(),
        active: z.boolean(),
      }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options).toHaveLength(3);
    const names = cmd.options.map((o) => o.name);
    expect(names).toEqual(["name", "age", "active"]);
  });
});

// ---------------------------------------------------------------------------
// Required vs optional fields
// ---------------------------------------------------------------------------

describe("generateDiscordCommand — required vs optional", () => {
  test("required field maps to required: true", () => {
    const def = makeDef({
      name: "req",
      input: z.object({ value: z.string() }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.required).toBe(true);
  });

  test("optional field maps to required: false", () => {
    const def = makeDef({
      name: "opt",
      input: z.object({ value: z.string().optional() }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.required).toBe(false);
  });

  test("field with default maps to required: false", () => {
    const def = makeDef({
      name: "default-field",
      input: z.object({ value: z.string().default("hello") }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fallback for complex schemas
// ---------------------------------------------------------------------------

describe("generateDiscordCommand — complex schema fallback", () => {
  test("nested object triggers fallback to generic JSON input", () => {
    const def = makeDef({
      name: "complex",
      input: z.object({ nested: z.object({ foo: z.string() }) }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options).toHaveLength(1);
    expect(cmd.options[0]!).toEqual({
      name: "input",
      description: "JSON input",
      type: "string",
      required: false,
    });
  });

  test("array field triggers fallback to generic JSON input", () => {
    const def = makeDef({
      name: "with-array",
      input: z.object({ items: z.array(z.string()) }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options).toHaveLength(1);
    expect(cmd.options[0]!.name).toBe("input");
  });

  test("more than 5 fields triggers fallback", () => {
    const def = makeDef({
      name: "many-fields",
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
    expect(cmd.options).toHaveLength(1);
    expect(cmd.options[0]!.name).toBe("input");
  });

  test("non-object schema triggers fallback", () => {
    const def = makeDef({
      name: "string-input",
      input: z.string(),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options).toHaveLength(1);
    expect(cmd.options[0]!.name).toBe("input");
  });
});

// ---------------------------------------------------------------------------
// Discord annotation overrides
// ---------------------------------------------------------------------------

describe("generateDiscordCommand — discord annotation overrides", () => {
  test("custom description from discord annotation", () => {
    const def = makeDef({
      name: "annotated",
      description: "base description",
      input: z.object({}),
      discord: { description: "custom discord description" },
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.description).toBe("custom discord description");
  });

  test("falls back to base description when no discord annotation", () => {
    const def = makeDef({
      name: "plain",
      description: "base description",
      input: z.object({}),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.description).toBe("base description");
  });

  test("description is truncated to 100 characters", () => {
    const longDesc = "a".repeat(150);
    const def = makeDef({
      name: "long-desc",
      description: longDesc,
      input: z.object({}),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.description).toHaveLength(100);
  });

  test("inputMapper is passed through", () => {
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
// Surface filtering
// ---------------------------------------------------------------------------

describe("generateDiscordCommand — surface filtering", () => {
  test("returns null when discord is not in surfaces", () => {
    const def = makeDef({
      name: "api-only",
      input: z.object({}),
      surfaces: ["api"],
    });
    expect(generateDiscordCommand(def)).toBeNull();
  });

  test("returns null for agent-only surface", () => {
    const def = makeDef({
      name: "agent-only",
      input: z.object({}),
      surfaces: ["agent"],
    });
    expect(generateDiscordCommand(def)).toBeNull();
  });

  test("returns command when discord is in surfaces", () => {
    const def = makeDef({
      name: "discord-fn",
      input: z.object({}),
      surfaces: ["discord"],
    });
    expect(generateDiscordCommand(def)).not.toBeNull();
  });

  test("returns command when surfaces defaults (all three)", () => {
    const def = makeDef({
      name: "default-surfaces",
      input: z.object({}),
    });
    expect(generateDiscordCommand(def)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generateDiscordCommands (batch)
// ---------------------------------------------------------------------------

describe("generateDiscordCommands — batch generation", () => {
  test("filters out non-discord functions", () => {
    const defs = [
      makeDef({ name: "discord-fn", input: z.object({}), surfaces: ["discord"] }),
      makeDef({ name: "api-only", input: z.object({}), surfaces: ["api"] }),
      makeDef({ name: "also-discord", input: z.object({}), surfaces: ["discord", "api"] }),
    ];
    const commands = generateDiscordCommands(defs);
    expect(commands).toHaveLength(2);
    expect(commands.map((c) => c.name)).toEqual(["discord-fn", "also-discord"]);
  });

  test("returns empty array when no definitions have discord surface", () => {
    const defs = [
      makeDef({ name: "api-only", input: z.object({}), surfaces: ["api"] }),
    ];
    const commands = generateDiscordCommands(defs);
    expect(commands).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Feature gating
// ---------------------------------------------------------------------------

describe("generateDiscordCommands — feature gating", () => {
  test("excludes gated function when feature is inactive", () => {
    const defs = [
      makeDef({ name: "gated", input: z.object({}), featureGate: "finance" }),
      makeDef({ name: "ungated", input: z.object({}) }),
    ];
    const commands = generateDiscordCommands(defs, () => false);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe("ungated");
  });

  test("includes gated function when feature is active", () => {
    const defs = [
      makeDef({ name: "gated", input: z.object({}), featureGate: "finance" }),
      makeDef({ name: "ungated", input: z.object({}) }),
    ];
    const commands = generateDiscordCommands(defs, () => true);
    expect(commands).toHaveLength(2);
  });

  test("includes gated function when no featureChecker is provided", () => {
    const defs = [
      makeDef({ name: "gated", input: z.object({}), featureGate: "finance" }),
    ];
    const commands = generateDiscordCommands(defs);
    expect(commands).toHaveLength(1);
  });

  test("featureChecker receives the correct feature id", () => {
    const defs = [
      makeDef({ name: "a", input: z.object({}), featureGate: "calendar" }),
      makeDef({ name: "b", input: z.object({}), featureGate: "email" }),
    ];
    const checkedIds: string[] = [];
    generateDiscordCommands(defs, (id) => {
      checkedIds.push(id);
      return true;
    });
    expect(checkedIds).toEqual(["calendar", "email"]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("generateDiscordCommand — edge cases", () => {
  test("empty object schema produces no options", () => {
    const def = makeDef({
      name: "no-args",
      input: z.object({}),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options).toHaveLength(0);
  });

  test("enum with more than 25 values truncates choices to 25", () => {
    const values = Array.from({ length: 30 }, (_, i) => `val${i}`) as [string, ...string[]];
    const def = makeDef({
      name: "big-enum",
      input: z.object({ pick: z.enum(values) }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.choices).toHaveLength(25);
  });

  test("optional enum still produces choices", () => {
    const def = makeDef({
      name: "opt-enum",
      input: z.object({ mode: z.enum(["fast", "slow"]).optional() }),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.options[0]!.required).toBe(false);
    expect(cmd.options[0]!.choices).toEqual([
      { name: "fast", value: "fast" },
      { name: "slow", value: "slow" },
    ]);
  });

  test("command name matches function definition name", () => {
    const def = makeDef({
      name: "my-command",
      input: z.object({}),
    });
    const cmd = generateDiscordCommand(def)!;
    expect(cmd.name).toBe("my-command");
  });
});
