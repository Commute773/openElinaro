/**
 * Generates an OpenAPI 3.1 specification from FunctionDefinitions.
 * Replaces the hand-written static spec in src/integrations/http/openapi.ts.
 */
import { z } from "zod";
import type { FunctionDefinition } from "./define-function";
import { API_PATH_PREFIX } from "./define-function";
import type { FeatureId } from "../services/feature-config-service";

// ---------------------------------------------------------------------------
// Zod-to-JSON-Schema conversion (lightweight, no external deps)
// ---------------------------------------------------------------------------

/** Access Zod internal `_def` property (no public API for schema introspection). */
function zodDef(schema: z.ZodType): Record<string, unknown> {
  return (schema as unknown as Record<string, unknown>)._def as Record<string, unknown>;
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) {
    const checks = (zodDef(schema).checks ?? []) as { kind: string }[];
    const hasInt = checks.some((c) => c.kind === "int");
    return { type: hasInt ? "integer" : "number" };
  }
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodLiteral) {
    const value = zodDef(schema).value;
    return { type: typeof value, const: value };
  }
  if (schema instanceof z.ZodEnum) {
    const entries = zodDef(schema).entries as Record<string, string> | undefined;
    const values = entries ? Object.values(entries) : (schema as any).options as string[];
    return { type: "string", enum: values };
  }
  if (schema instanceof z.ZodArray) return { type: "array", items: zodToJsonSchema(zodDef(schema).type as z.ZodType) };
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(zodDef(schema).innerType as z.ZodType);
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(zodDef(schema).innerType as z.ZodType);
  if (schema instanceof z.ZodNullable) return { oneOf: [zodToJsonSchema(zodDef(schema).innerType as z.ZodType), { type: "null" }] };
  if (schema instanceof z.ZodUnion) {
    const options = zodDef(schema).options as z.ZodType[];
    return { oneOf: options.map(zodToJsonSchema) };
  }
  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<Record<string, z.ZodType>>).shape as Record<string, z.ZodType>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    const result: Record<string, unknown> = { type: "object", properties };
    if (required.length > 0) result.required = required;
    return result;
  }
  // Fallback for unknown/complex types
  return {};
}

// ---------------------------------------------------------------------------
// OpenAPI generation
// ---------------------------------------------------------------------------

interface OpenApiOptions {
  title?: string;
  version?: string;
  serverUrl?: string;
}

function buildPathParameters(def: FunctionDefinition): Record<string, unknown>[] {
  const params: Record<string, unknown>[] = [];

  // Path params from :param segments
  const pathPattern = def.http!.path;
  const paramRe = /:([^/]+)/g;
  let match: RegExpExecArray | null;
  while ((match = paramRe.exec(pathPattern)) !== null) {
    params.push({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }

  // Query params from annotation
  if (def.http!.method === "GET" && def.http!.queryParams instanceof z.ZodObject) {
    const shape = def.http!.queryParams.shape as Record<string, z.ZodType>;
    for (const [key, value] of Object.entries(shape)) {
      params.push({
        name: key,
        in: "query",
        required: !(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault),
        schema: zodToJsonSchema(value),
      });
    }
  }

  return params;
}

export function generateOpenApiSpec(
  definitions: FunctionDefinition[],
  featureChecker?: (featureId: FeatureId) => boolean,
  options?: OpenApiOptions,
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const def of definitions) {
    const surfaces = def.surfaces ?? ["api", "discord", "agent"];
    if (!surfaces.includes("api")) continue;
    if (!def.http) continue;
    if (def.featureGate && featureChecker && !featureChecker(def.featureGate)) continue;

    const method = def.http.method.toLowerCase();
    // Resolve full path: relative paths get the prefix prepended
    const rawPath = def.http.path.startsWith("/api/")
      ? def.http.path
      : `${API_PATH_PREFIX}${def.http.path}`;
    // Convert Express :param to OpenAPI {param}
    const path = rawPath.replace(/:([^/]+)/g, "{$1}");

    const operation: Record<string, unknown> = {
      operationId: def.name,
      summary: def.description,
      tags: def.domains,
    };

    // Parameters
    const parameters = buildPathParameters(def);
    if (parameters.length > 0) operation.parameters = parameters;

    // Request body (for non-GET methods)
    if (def.http.method !== "GET" && def.input instanceof z.ZodObject) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: zodToJsonSchema(def.input),
          },
        },
      };
    }

    // Responses
    const successStatus = String(def.http.successStatus ?? 200);
    operation.responses = {
      [successStatus]: {
        description: "Success",
        content: def.output
          ? { "application/json": { schema: zodToJsonSchema(def.output) } }
          : { "application/json": { schema: { type: "object" } } },
      },
      "400": {
        description: "Validation error",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      },
      "500": {
        description: "Internal error",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      },
    };

    paths[path] ??= {};
    paths[path][method] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: options?.title ?? "OpenElinaro API",
      version: options?.version ?? "2.0.0",
    },
    servers: [{ url: options?.serverUrl ?? "http://localhost:3000" }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
          },
          required: ["error"],
        },
      },
    },
  };
}
