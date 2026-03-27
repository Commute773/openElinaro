/**
 * Generates Discord slash command metadata from FunctionDefinitions.
 * This produces the data structures needed for discord.js command registration
 * and runtime dispatch.
 */
import { z } from "zod";
import type { FunctionDefinition } from "./define-function";

// ---------------------------------------------------------------------------
// Discord command descriptor (platform-agnostic representation)
// ---------------------------------------------------------------------------

export interface DiscordCommandDescriptor {
  /** The function definition name (used for dispatch). */
  name: string;
  /** Description for the slash command. */
  description: string;
  /** Options derived from the input schema. */
  options: DiscordCommandOption[];
  /** Custom input mapper from the function definition. */
  inputMapper?: (interaction: unknown) => unknown;
}

export interface DiscordCommandOption {
  name: string;
  description: string;
  type: "string" | "integer" | "number" | "boolean";
  required: boolean;
  choices?: { name: string; value: string | number }[];
}

// ---------------------------------------------------------------------------
// Schema introspection helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a Zod schema has simple enough top-level fields to
 * auto-generate Discord command options (max 5 primitive fields).
 */
function canAutoGenerateOptions(schema: any): boolean {
  if (!(schema instanceof z.ZodObject)) return false;
  const shape = schema.shape;
  const keys = Object.keys(shape);
  if (keys.length > 5) return false;
  return keys.every((k: string) => {
    const field = unwrapOptional(shape[k]);
    return (
      field instanceof z.ZodString ||
      field instanceof z.ZodNumber ||
      field instanceof z.ZodBoolean ||
      field instanceof z.ZodEnum
    );
  });
}

function unwrapOptional(field: any): any {
  if (field instanceof z.ZodOptional) return field.unwrap();
  if (field instanceof z.ZodDefault) return unwrapOptional(field.removeDefault());
  return field;
}

function zodToDiscordType(field: any): DiscordCommandOption["type"] {
  const inner = unwrapOptional(field);
  if (inner instanceof z.ZodNumber) {
    // Check if it has int() check
    const checks = (inner as any)._def?.checks ?? [];
    const hasInt = checks.some((c: any) => c.kind === "int");
    return hasInt ? "integer" : "number";
  }
  if (inner instanceof z.ZodBoolean) return "boolean";
  return "string"; // string, enum, and fallback
}

function isRequired(field: any): boolean {
  return !(field instanceof z.ZodOptional) && !(field instanceof z.ZodDefault);
}

function extractEnumChoices(field: any): { name: string; value: string }[] | undefined {
  const inner = unwrapOptional(field);
  if (inner instanceof z.ZodEnum) {
    const values = inner.options as string[];
    return values.slice(0, 25).map((v) => ({ name: v, value: v })); // Discord max 25 choices
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Generate a DiscordCommandDescriptor for a single FunctionDefinition.
 * Returns null if the function excludes the Discord surface.
 */
export function generateDiscordCommand(def: FunctionDefinition): DiscordCommandDescriptor | null {
  const surfaces = def.surfaces ?? ["api", "discord", "agent"];
  if (!surfaces.includes("discord")) return null;

  const description = (def.discord?.description ?? def.description).slice(0, 100);
  const options: DiscordCommandOption[] = [];

  if (def.input instanceof z.ZodObject && canAutoGenerateOptions(def.input)) {
    const shape = (def.input as any).shape;
    for (const [key, field] of Object.entries(shape)) {
      options.push({
        name: key,
        description: key, // Discord requires a description; use key as fallback
        type: zodToDiscordType(field),
        required: isRequired(field),
        choices: extractEnumChoices(field),
      });
    }
  } else if (!(def.input instanceof z.ZodObject) || Object.keys((def.input as any).shape ?? {}).length > 0) {
    // Complex schema: fall back to generic JSON input option
    options.push({
      name: "input",
      description: "JSON input",
      type: "string",
      required: false,
    });
  }

  return {
    name: def.name,
    description,
    options,
    inputMapper: def.discord?.inputMapper,
  };
}

/**
 * Generate DiscordCommandDescriptor[] for all Discord-surface definitions.
 */
export function generateDiscordCommands(
  definitions: FunctionDefinition[],
  featureChecker?: (featureId: string) => boolean,
): DiscordCommandDescriptor[] {
  const commands: DiscordCommandDescriptor[] = [];
  for (const def of definitions) {
    if (def.featureGate && featureChecker && !featureChecker(def.featureGate)) continue;
    const cmd = generateDiscordCommand(def);
    if (cmd) commands.push(cmd);
  }
  return commands;
}
