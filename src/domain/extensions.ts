import { z } from "zod";

/**
 * Zod schema for an extension manifest (`extension.json`).
 *
 * Each extension lives under `~/.openelinaro/extensions/<id>/` and must
 * contain an `extension.json` that conforms to this schema.
 */
export const ExtensionManifestSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase alphanumeric with hyphens"),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(""),
  author: z.string().default(""),
  entrypoint: z.string().min(1),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

/**
 * The API surface exposed to an extension's entrypoint module.
 *
 * Extensions receive an `ExtensionAPI` instance at activation time and use it
 * to register tools, subscribe to events, and read their own config.
 */
export interface ExtensionAPI {
  /** Register a single tool that the agent can invoke. */
  registerTool(name: string, schema: z.ZodType, handler: (input: unknown) => Promise<unknown>): void;

  /** Group previously registered tools into a named library. */
  registerToolLibrary(id: string, description: string, toolNames: string[]): void;

  /** Subscribe to a named runtime event. */
  onEvent(eventName: string, handler: (...args: unknown[]) => void): void;

  /** Read the extension's own config block from the runtime config. */
  getConfig(): Record<string, unknown>;
}

/** A tool registered by an extension via `ExtensionAPI.registerTool`. */
export interface RegisteredExtensionTool {
  extensionId: string;
  name: string;
  schema: z.ZodType;
  handler: (input: unknown) => Promise<unknown>;
}

/** A tool library grouping registered by an extension. */
export interface RegisteredToolLibrary {
  extensionId: string;
  id: string;
  description: string;
  toolNames: string[];
}

export type ExtensionStatus = "discovered" | "valid" | "invalid" | "loaded" | "error";

/**
 * Runtime representation of a discovered extension directory.
 */
export interface LoadedExtension {
  manifest: ExtensionManifest | null;
  status: ExtensionStatus;
  error: string | null;
  dirPath: string;
}
