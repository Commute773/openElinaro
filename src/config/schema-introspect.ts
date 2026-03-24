import { z, type ZodTypeAny } from "zod";
import { RuntimeConfigSchema } from "./runtime-config";

// Zod v4 internal types ($ZodType) don't always match the public ZodType.
// We cast through unknown where needed to bridge the gap.
function asZod(s: unknown): ZodTypeAny {
  return s as ZodTypeAny;
}

// ---------------------------------------------------------------------------
// Path parsing — supports "foo.bar[0].baz" notation
// ---------------------------------------------------------------------------

function parsePathSegments(expr: string): string[] {
  const s = expr.trim();
  if (!s) return [];
  const segments: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ".") {
      if (buf) { segments.push(buf); buf = ""; }
    } else if (s[i] === "[") {
      if (buf) { segments.push(buf); buf = ""; }
      const end = s.indexOf("]", i);
      if (end === -1) throw new Error(`Unmatched '[' in path: ${expr}`);
      segments.push(s.slice(i, end + 1));
      i = end;
    } else {
      buf += s[i];
    }
  }
  if (buf) segments.push(buf);
  return segments;
}

// ---------------------------------------------------------------------------
// Schema unwrapping — strip Default, Optional, Nullable wrappers
// ---------------------------------------------------------------------------

interface SchemaMeta {
  inner: ZodTypeAny;
  optional: boolean;
  nullable: boolean;
  hasDefault: boolean;
  defaultValue: unknown;
}

function analyze(schema: ZodTypeAny): SchemaMeta {
  let cur = schema;
  let optional = false;
  let nullable = false;
  let hasDefault = false;
  let defaultValue: unknown;
  for (;;) {
    if (cur instanceof z.ZodDefault) {
      hasDefault = true;
      defaultValue = cur._def.defaultValue;
      cur = asZod(cur._def.innerType);
    } else if (cur instanceof z.ZodOptional) {
      optional = true;
      cur = asZod(cur._def.innerType);
    } else if (cur instanceof z.ZodNullable) {
      nullable = true;
      cur = asZod(cur._def.innerType);
    } else {
      break;
    }
  }
  return { inner: cur, optional, nullable, hasDefault, defaultValue };
}

function unwrap(s: ZodTypeAny): ZodTypeAny {
  return analyze(s).inner;
}

// ---------------------------------------------------------------------------
// Schema navigation
// ---------------------------------------------------------------------------

function navigateSegment(schema: ZodTypeAny, seg: string): ZodTypeAny {
  const inner = unwrap(schema);

  if (seg.startsWith("[") && seg.endsWith("]")) {
    if (inner instanceof z.ZodArray) return asZod(inner.element);
    if (inner instanceof z.ZodTuple) {
      const idx = parseInt(seg.slice(1, -1), 10);
      const items = inner._def.items as unknown[];
      if (idx >= 0 && idx < items.length) return asZod(items[idx]);
      throw new Error(`Tuple index ${idx} out of range (0..${items.length - 1}).`);
    }
    throw new Error(`Cannot index with ${seg} on ${baseTypeName(inner)}.`);
  }

  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, unknown>;
    if (seg in shape) return asZod(shape[seg]);
    throw new Error(`Unknown key "${seg}". Available: ${Object.keys(shape).join(", ")}`);
  }
  if (inner instanceof z.ZodRecord) return asZod(inner.valueType);

  throw new Error(`Cannot navigate "${seg}" on ${baseTypeName(inner)}.`);
}

function resolveSchemaAtPath(root: ZodTypeAny, pathExpression: string): ZodTypeAny {
  let cur = root;
  for (const seg of parsePathSegments(pathExpression)) {
    cur = navigateSegment(cur, seg);
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Type naming
// ---------------------------------------------------------------------------

function baseTypeName(schema: ZodTypeAny): string {
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodEnum) return "enum";
  if (schema instanceof z.ZodArray) return "array";
  if (schema instanceof z.ZodTuple) return "tuple";
  if (schema instanceof z.ZodRecord) return "record";
  if (schema instanceof z.ZodObject) return "object";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Constraint extraction (Zod v4 API)
// ---------------------------------------------------------------------------

interface ZodCheckDef {
  check?: string;
  value?: number;
  inclusive?: boolean;
}

function getCheckDef(check: unknown): ZodCheckDef | undefined {
  return (check as { _zod?: { def?: ZodCheckDef } })?._zod?.def;
}

function extractNumberChecks(schema: z.ZodNumber): string[] {
  const out: string[] = [];
  if (schema.isInt) out.push("int");

  for (const check of schema._def.checks ?? []) {
    const def = getCheckDef(check);
    if (!def?.check) continue;
    if (def.check === "greater_than") {
      const value = def.value ?? 0;
      const inclusive = def.inclusive ?? false;
      if (value === 0 && !inclusive) out.push("positive");
      else if (value === 0 && inclusive) out.push("nonnegative");
      else out.push(inclusive ? `>= ${value}` : `> ${value}`);
    } else if (def.check === "less_than") {
      const value = def.value ?? 0;
      const inclusive = def.inclusive ?? false;
      out.push(inclusive ? `<= ${value}` : `< ${value}`);
    }
  }

  return out;
}

function extractStringChecks(schema: z.ZodString): string[] {
  const out: string[] = [];
  if (schema.minLength != null && schema.minLength > 0) {
    out.push(`min_length: ${schema.minLength}`);
  }
  if (schema.maxLength != null) {
    out.push(`max_length: ${schema.maxLength}`);
  }
  return out;
}

function extractChecks(schema: ZodTypeAny): string[] {
  if (schema instanceof z.ZodNumber) return extractNumberChecks(schema);
  if (schema instanceof z.ZodString) return extractStringChecks(schema);
  return [];
}

// ---------------------------------------------------------------------------
// Inline type description — compact, with constraints embedded
// Used inside container type references: array<...>, [tuple, items], etc.
// ---------------------------------------------------------------------------

function inlineDesc(schema: ZodTypeAny): string {
  const { inner, nullable, optional } = analyze(schema);

  let base: string;
  if (inner instanceof z.ZodString || inner instanceof z.ZodNumber) {
    base = baseTypeName(inner);
    const c = extractChecks(inner);
    if (c.length) base += ` (${c.join(", ")})`;
  } else if (inner instanceof z.ZodBoolean) {
    base = "boolean";
  } else if (inner instanceof z.ZodEnum) {
    const vals = inner.options as string[];
    base = vals.length <= 8
      ? vals.map((v: string) => `"${v}"`).join(" | ")
      : `enum(${vals.length} values)`;
  } else if (inner instanceof z.ZodArray) {
    base = `array<${inlineDesc(asZod(inner.element))}>`;
  } else if (inner instanceof z.ZodTuple) {
    const items = (inner._def.items as unknown[]).map((i) => inlineDesc(asZod(i)));
    base = `[${items.join(", ")}]`;
  } else if (inner instanceof z.ZodRecord) {
    base = `record<${inlineDesc(asZod(inner.keyType))}, ${inlineDesc(asZod(inner.valueType))}>`;
  } else if (inner instanceof z.ZodObject) {
    base = `object { ${Object.keys(inner.shape as Record<string, unknown>).join(", ")} }`;
  } else {
    base = "unknown";
  }

  if (nullable) base += " | null";
  if (optional) base += "?";
  return base;
}

// ---------------------------------------------------------------------------
// Default formatting
// ---------------------------------------------------------------------------

function fmtDefault(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.length === 0 ? "[]" : `[...${v.length} items]`;
  if (typeof v === "object" && v !== null) {
    const n = Object.keys(v).length;
    return n === 0 ? "{}" : `{...${n} keys}`;
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Parts-based description — separates type structure from annotations
// ---------------------------------------------------------------------------

function descriptionParts(
  schema: ZodTypeAny,
  opts?: { includeDefault?: boolean },
): { typeStr: string; annotations: string[] } {
  const m = analyze(schema);
  const inner = m.inner;
  const includeDefault = opts?.includeDefault ?? true;

  let typeStr: string;
  if (inner instanceof z.ZodString) typeStr = "string";
  else if (inner instanceof z.ZodNumber) typeStr = "number";
  else if (inner instanceof z.ZodBoolean) typeStr = "boolean";
  else if (inner instanceof z.ZodEnum) {
    const vals = inner.options as string[];
    typeStr = vals.length <= 8
      ? vals.map((v: string) => `"${v}"`).join(" | ")
      : `enum(${vals.length} values)`;
  } else if (inner instanceof z.ZodArray) {
    typeStr = `array<${inlineDesc(asZod(inner.element))}>`;
  } else if (inner instanceof z.ZodTuple) {
    typeStr = `[${(inner._def.items as unknown[]).map((i) => inlineDesc(asZod(i))).join(", ")}]`;
  } else if (inner instanceof z.ZodRecord) {
    typeStr = `record<${inlineDesc(asZod(inner.keyType))}, ${inlineDesc(asZod(inner.valueType))}>`;
  } else if (inner instanceof z.ZodObject) {
    typeStr = `object { ${Object.keys(inner.shape as Record<string, unknown>).join(", ")} }`;
  } else {
    typeStr = "unknown";
  }

  if (m.nullable) typeStr += " | null";
  if (m.optional) typeStr += "?";

  const annotations: string[] = [...extractChecks(inner)];
  if (includeDefault && m.hasDefault) {
    annotations.push(`default: ${fmtDefault(m.defaultValue)}`);
  }

  return { typeStr, annotations };
}

function formatParts({ typeStr, annotations }: { typeStr: string; annotations: string[] }): string {
  return annotations.length ? `${typeStr} (${annotations.join(", ")})` : typeStr;
}

// ---------------------------------------------------------------------------
// Expanded description — full detail for a target schema node
// Objects expand one level showing children with types and constraints
// ---------------------------------------------------------------------------

function describeExpanded(schema: ZodTypeAny): string {
  const inner = unwrap(schema);

  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, unknown>;
    const lines = ["object {"];
    for (const [key, child] of Object.entries(shape)) {
      const childSchema = asZod(child);
      const childInner = unwrap(childSchema);
      const parts = descriptionParts(childSchema, {
        includeDefault: !(childInner instanceof z.ZodObject),
      });
      lines.push(`  ${key}: ${formatParts(parts)}`);
    }
    lines.push("}");
    return lines.join("\n");
  }

  return formatParts(descriptionParts(schema));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Describe the runtime config schema at the given path, or the whole root if
 * no path is provided. Returns a human-readable type description with
 * constraints, defaults, and available keys.
 *
 * Path supports dot notation and bracket notation:
 *   - "core.http.port" → scalar leaf
 *   - "core.http" → object with children expanded
 *   - "core.discord.guildIds[0]" → array element schema
 *   - "" or undefined → root config object
 */
export function describeRuntimeConfigSchema(pathExpression?: string): string {
  const path = pathExpression?.trim() ?? "";
  const schema = path
    ? resolveSchemaAtPath(RuntimeConfigSchema, path)
    : RuntimeConfigSchema;
  const label = path || "(root)";
  return `${label}: ${describeExpanded(schema)}`;
}
