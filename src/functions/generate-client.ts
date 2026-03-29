/**
 * Generates a typed TypeScript HTTP client from FunctionDefinitions.
 *
 * The generated client:
 * - Has one method per API-surface function
 * - Uses fetch() with no dependencies
 * - Includes JSDoc from function descriptions
 * - Exports the full OpenAPI spec as a JSON constant
 *
 * Usage:
 *   bun src/functions/generate-client.ts > client.ts
 *   bun src/functions/generate-client.ts --out path/to/client.ts
 */
import { z } from "zod";
import type { FunctionDefinition, HttpMethod } from "./define-function";
import { API_PATH_PREFIX } from "./define-function";
import { ALL_FUNCTION_BUILDERS } from "./domains/index";
import { generateOpenApiSpec } from "./generate-openapi";

// ---------------------------------------------------------------------------
// Zod → TypeScript type string
// ---------------------------------------------------------------------------

function zodDef(schema: z.ZodType): Record<string, unknown> {
  return (schema as unknown as Record<string, unknown>)._def as Record<string, unknown>;
}

function zodToTsType(schema: z.ZodType, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) {
    const checks = (zodDef(schema).checks ?? []) as { kind: string }[];
    return checks.some((c) => c.kind === "int") ? "number" : "number";
  }
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodLiteral) {
    const val = zodDef(schema).value;
    return typeof val === "string" ? `"${val}"` : String(val);
  }
  if (schema instanceof z.ZodEnum) {
    // Zod 4: entries is { a: "a", b: "b" }, Zod 3: values is ["a", "b"]
    const entries = zodDef(schema).entries as Record<string, string> | undefined;
    const values = entries ? Object.values(entries) : (schema as any).options as string[];
    return values.map((v: string) => `"${v}"`).join(" | ");
  }
  if (schema instanceof z.ZodArray) {
    const inner = zodToTsType(zodDef(schema).type as z.ZodType, indent);
    return `${inner}[]`;
  }
  if (schema instanceof z.ZodOptional) {
    return zodToTsType(zodDef(schema).innerType as z.ZodType, indent);
  }
  if (schema instanceof z.ZodDefault) {
    return zodToTsType(zodDef(schema).innerType as z.ZodType, indent);
  }
  if (schema instanceof z.ZodNullable) {
    const inner = zodToTsType(zodDef(schema).innerType as z.ZodType, indent);
    return `${inner} | null`;
  }
  if (schema instanceof z.ZodUnion) {
    const options = zodDef(schema).options as z.ZodType[];
    return options.map((o) => zodToTsType(o, indent)).join(" | ");
  }
  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<Record<string, z.ZodType>>).shape as Record<string, z.ZodType>;
    const entries = Object.entries(shape);
    if (entries.length === 0) return "Record<string, never>";
    const inner = entries.map(([key, value]) => {
      const optional = value instanceof z.ZodOptional || value instanceof z.ZodDefault;
      const tsType = zodToTsType(value, indent + 1);
      return `${pad}  ${key}${optional ? "?" : ""}: ${tsType};`;
    }).join("\n");
    return `{\n${inner}\n${pad}}`;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Extract path params from Express-style pattern
// ---------------------------------------------------------------------------

function extractPathParams(path: string): string[] {
  const names: string[] = [];
  const re = /:([^/]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) names.push(m[1]!);
  return names;
}

// ---------------------------------------------------------------------------
// camelCase a snake_case function name
// ---------------------------------------------------------------------------

function toCamelCase(name: string): string {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Determine input fields excluding path params (those go in the URL)
// ---------------------------------------------------------------------------

function getBodyFields(
  schema: z.ZodType,
  pathParams: string[],
): Array<{ name: string; type: string; optional: boolean }> {
  if (!(schema instanceof z.ZodObject)) return [];
  const shape = (schema as z.ZodObject<Record<string, z.ZodType>>).shape as Record<string, z.ZodType>;
  return Object.entries(shape)
    .filter(([key]) => !pathParams.includes(key))
    .map(([key, value]) => ({
      name: key,
      type: zodToTsType(value),
      optional: value instanceof z.ZodOptional || value instanceof z.ZodDefault,
    }));
}

// ---------------------------------------------------------------------------
// Generate client source
// ---------------------------------------------------------------------------

interface ApiFunction {
  name: string;
  description: string;
  method: HttpMethod;
  path: string;
  pathParams: string[];
  bodyFields: Array<{ name: string; type: string; optional: boolean }>;
  inputType: string;
}

function collectApiFunctions(definitions: FunctionDefinition[]): ApiFunction[] {
  const fns: ApiFunction[] = [];
  for (const def of definitions) {
    const surfaces = def.surfaces ?? ["api", "discord", "agent"];
    if (!surfaces.includes("api") || !def.http) continue;
    const pathParams = extractPathParams(def.http.path);
    const bodyFields = getBodyFields(def.input, pathParams);
    fns.push({
      name: def.name,
      description: def.description,
      method: def.http.method,
      path: def.http.path,
      pathParams,
      bodyFields,
      inputType: zodToTsType(def.input),
    });
  }
  return fns;
}

function generateMethodSignature(fn: ApiFunction): string {
  const params: string[] = [];
  // Path params first
  for (const p of fn.pathParams) {
    params.push(`${p}: string`);
  }
  // Body/query params
  if (fn.bodyFields.length > 0) {
    const allOptional = fn.bodyFields.every((f) => f.optional);
    const fieldsType = fn.bodyFields
      .map((f) => `${f.name}${f.optional ? "?" : ""}: ${f.type}`)
      .join("; ");
    params.push(`params${allOptional ? "?" : ""}: { ${fieldsType} }`);
  }
  return params.join(", ");
}

function generateMethodBody(fn: ApiFunction): string {
  const fullPath = fn.path.startsWith("/api/")
    ? fn.path
    : `\${this.prefix}${fn.path}`;
  // Replace :param with ${param}
  const urlTemplate = fullPath.replace(/:([^/]+)/g, (_, name) => `\${${name}}`);

  const lines: string[] = [];

  if (fn.method === "GET" && fn.bodyFields.length > 0) {
    lines.push(`    const query = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString() : "";`);
    lines.push(`    const sep = query ? "?" : "";`);
    lines.push(`    return this.request("GET", \`${urlTemplate}\${sep}\${query}\`);`);
  } else if (fn.method === "GET") {
    lines.push(`    return this.request("GET", \`${urlTemplate}\`);`);
  } else {
    const hasBody = fn.bodyFields.length > 0;
    if (hasBody) {
      lines.push(`    return this.request("${fn.method}", \`${urlTemplate}\`, params);`);
    } else {
      lines.push(`    return this.request("${fn.method}", \`${urlTemplate}\`);`);
    }
  }

  return lines.join("\n");
}

function generateClientSource(definitions: FunctionDefinition[]): string {
  const fns = collectApiFunctions(definitions);
  const spec = generateOpenApiSpec(definitions);

  const lines: string[] = [];
  lines.push(`/**`);
  lines.push(` * Auto-generated API client from FunctionDefinitions.`);
  lines.push(` * Do not edit manually — regenerate with: bun src/functions/generate-client.ts`);
  lines.push(` * Generated: ${new Date().toISOString()}`);
  lines.push(` */`);
  lines.push(``);
  lines.push(`// ---------------------------------------------------------------------------`);
  lines.push(`// OpenAPI spec (embedded for tooling / UI codegen)`);
  lines.push(`// ---------------------------------------------------------------------------`);
  lines.push(``);
  lines.push(`export const OPENAPI_SPEC = ${JSON.stringify(spec, null, 2)} as const;`);
  lines.push(``);
  lines.push(`// ---------------------------------------------------------------------------`);
  lines.push(`// Endpoint metadata (for UI codegen)`);
  lines.push(`// ---------------------------------------------------------------------------`);
  lines.push(``);

  const endpointMeta = fns.map((fn) => ({
    name: fn.name,
    method: fn.method,
    path: fn.path,
    description: fn.description,
    pathParams: fn.pathParams,
    bodyFields: fn.bodyFields.map((f) => ({ name: f.name, type: f.type, optional: f.optional })),
  }));
  lines.push(`export const ENDPOINTS = ${JSON.stringify(endpointMeta, null, 2)} as const;`);
  lines.push(``);
  lines.push(`export type EndpointName = typeof ENDPOINTS[number]["name"];`);
  lines.push(``);

  lines.push(`// ---------------------------------------------------------------------------`);
  lines.push(`// Client class`);
  lines.push(`// ---------------------------------------------------------------------------`);
  lines.push(``);
  lines.push(`export class OpenElinaroClient {`);
  lines.push(`  constructor(`);
  lines.push(`    private baseUrl: string = "http://localhost:3000",`);
  lines.push(`    private prefix: string = "/api/g2",`);
  lines.push(`    private headers: Record<string, string> = {},`);
  lines.push(`  ) {}`);
  lines.push(``);
  lines.push(`  private async request(method: string, path: string, body?: unknown): Promise<unknown> {`);
  lines.push(`    const url = \`\${this.baseUrl}\${path}\`;`);
  lines.push(`    const res = await fetch(url, {`);
  lines.push(`      method,`);
  lines.push(`      headers: {`);
  lines.push(`        "Content-Type": "application/json",`);
  lines.push(`        ...this.headers,`);
  lines.push(`      },`);
  lines.push(`      body: body ? JSON.stringify(body) : undefined,`);
  lines.push(`    });`);
  lines.push(`    if (!res.ok) {`);
  lines.push(`      const err = await res.json().catch(() => ({ error: res.statusText }));`);
  lines.push(`      throw Object.assign(new Error((err as any).error ?? res.statusText), { status: res.status, body: err });`);
  lines.push(`    }`);
  lines.push(`    return res.json();`);
  lines.push(`  }`);
  lines.push(``);

  for (const fn of fns) {
    const methodName = toCamelCase(fn.name);
    const sig = generateMethodSignature(fn);
    lines.push(`  /** ${fn.description} */`);
    lines.push(`  async ${methodName}(${sig}): Promise<unknown> {`);
    lines.push(generateMethodBody(fn));
    lines.push(`  }`);
    lines.push(``);
  }

  lines.push(`}`);
  lines.push(``);
  lines.push(`// Default export for convenience`);
  lines.push(`export default OpenElinaroClient;`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  // Build definitions using a stub context (we only need schemas, not runtime services)
  const stubCtx = new Proxy({} as any, {
    get: () => new Proxy({} as any, { get: () => () => {} }),
  });

  const definitions: FunctionDefinition[] = [];
  for (const builder of ALL_FUNCTION_BUILDERS) {
    try {
      definitions.push(...builder(stubCtx));
    } catch {
      // Some builders may fail with stub context — skip
    }
  }

  const source = generateClientSource(definitions);

  const outFlag = process.argv.indexOf("--out");
  if (outFlag !== -1 && process.argv[outFlag + 1]) {
    const outPath = process.argv[outFlag + 1]!;
    await Bun.write(outPath, source);
    console.error(`Client written to ${outPath}`);
  } else {
    process.stdout.write(source);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
