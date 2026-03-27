import fs from "node:fs";
import path from "node:path";
import {
  ExtensionManifestSchema,
  type ExtensionAPI,
  type ExtensionManifest,
  type HttpMethod,
  type LoadedExtension,
  type RegisteredExtensionTool,
  type RegisteredToolLibrary,
} from "../domain/extensions";
import { getRuntimeConfigValue } from "../config/runtime-config";
import { resolveUserDataPath } from "./runtime-root";

const EXTENSIONS_DIR = "extensions";
const MANIFEST_FILENAME = "extension.json";

export interface RegisteredHttpRoute {
  method: HttpMethod;
  path: string;
  handler: (request: Request) => Response | Promise<Response>;
  extensionId: string;
}

function getExtensionsDir() {
  return resolveUserDataPath(EXTENSIONS_DIR);
}

function readManifest(dirPath: string): { manifest: ExtensionManifest | null; error: string | null } {
  const manifestPath = path.join(dirPath, MANIFEST_FILENAME);
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    const manifest = ExtensionManifestSchema.parse(parsed);
    return { manifest, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manifest: null, error: message };
  }
}

export class ExtensionRegistryService {
  private extensions: LoadedExtension[] = [];
  private registeredTools = new Map<string, RegisteredExtensionTool>();
  private registeredLibraries = new Map<string, RegisteredToolLibrary>();
  private eventSubscriptions = new Map<string, Array<(...args: unknown[]) => void>>();
  private httpRoutes = new Map<string, RegisteredHttpRoute>();

  /**
   * Scan the extensions directory and validate each extension manifest.
   * Call this once at startup.
   */
  scan(): LoadedExtension[] {
    const extensionsDir = getExtensionsDir();
    this.extensions = [];

    if (!fs.existsSync(extensionsDir)) {
      return this.extensions;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
    } catch {
      return this.extensions;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirPath = path.join(extensionsDir, entry.name);
      const manifestPath = path.join(dirPath, MANIFEST_FILENAME);

      if (!fs.existsSync(manifestPath)) {
        this.extensions.push({
          manifest: null,
          status: "discovered",
          error: `Missing ${MANIFEST_FILENAME}`,
          dirPath,
        });
        continue;
      }

      const { manifest, error } = readManifest(dirPath);
      if (manifest) {
        this.extensions.push({ manifest, status: "valid", error: null, dirPath });
      } else {
        this.extensions.push({ manifest: null, status: "invalid", error, dirPath });
      }
    }

    return this.extensions;
  }

  /** Return all discovered extensions from the last scan. */
  list(): readonly LoadedExtension[] {
    return this.extensions;
  }

  /** Return only extensions with valid manifests. */
  listValid(): readonly LoadedExtension[] {
    return this.extensions.filter((ext) => ext.status === "valid");
  }

  /**
   * Load all valid extensions by dynamically importing their entrypoints
   * and calling their `activate` function with a scoped `ExtensionAPI`.
   */
  async loadAll(): Promise<void> {
    const valid = this.listValid();
    if (valid.length === 0) {
      return;
    }
    for (const ext of valid) {
      await this.loadExtension(ext);
    }
  }

  private async loadExtension(ext: LoadedExtension): Promise<void> {
    const manifest = ext.manifest!;
    const entrypointPath = path.resolve(ext.dirPath, manifest.entrypoint);

    try {
      const mod = await import(entrypointPath);
      const activate = mod.activate ?? mod.default?.activate;
      if (typeof activate !== "function") {
        throw new Error(`Entrypoint does not export an activate function`);
      }
      const api = this.createAPI(manifest.id);
      await activate(api);
      ext.status = "loaded";
      ext.error = null;
    } catch (err) {
      ext.status = "error";
      ext.error = err instanceof Error ? err.message : String(err);
      console.error(`[extensions] Failed to load ${manifest.id}: ${ext.error}`);
    }
  }

  private createAPI(extensionId: string): ExtensionAPI {
    return {
      registerTool: (name, schema, handler) => {
        const qualifiedName = `${extensionId}.${name}`;
        this.registeredTools.set(qualifiedName, { extensionId, name, schema, handler });
      },
      registerToolLibrary: (id, description, toolNames) => {
        this.registeredLibraries.set(id, { extensionId, id, description, toolNames });
      },
      onEvent: (eventName, handler) => {
        const handlers = this.eventSubscriptions.get(eventName) ?? [];
        handlers.push(handler);
        this.eventSubscriptions.set(eventName, handlers);
      },
      getConfig: () => {
        const value = getRuntimeConfigValue(`extensions.${extensionId}`);
        return (value && typeof value === "object" && !Array.isArray(value))
          ? value as Record<string, unknown>
          : {};
      },
      registerHttpRoute: (method, routePath, handler) => {
        this.registerHttpRoute(extensionId, method, routePath, handler);
      },
    };
  }

  /** Emit an event to all subscribed extension handlers. */
  emitEvent(eventName: string, ...args: unknown[]): void {
    const handlers = this.eventSubscriptions.get(eventName);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch (err) {
        console.error(`[extensions] Error in event handler for "${eventName}":`, err);
      }
    }
  }

  /** Return all tools registered by extensions. */
  getRegisteredTools(): ReadonlyMap<string, RegisteredExtensionTool> {
    return this.registeredTools;
  }

  /** Return all tool libraries registered by extensions. */
  getRegisteredLibraries(): ReadonlyMap<string, RegisteredToolLibrary> {
    return this.registeredLibraries;
  }

  registerHttpRoute(
    extensionId: string,
    method: HttpMethod,
    routePath: string,
    handler: (request: Request) => Response | Promise<Response>,
  ): void {
    const normalizedPath = routePath.startsWith("/") ? routePath : `/${routePath}`;
    const fullPath = `/api/ext/${extensionId}${normalizedPath}`;
    const key = `${method} ${fullPath}`;
    this.httpRoutes.set(key, { method, path: fullPath, handler, extensionId });
  }

  getRegisteredHttpRoutes(): RegisteredHttpRoute[] {
    return Array.from(this.httpRoutes.values());
  }

  async handleExtensionHttpRequest(request: Request, pathname: string): Promise<Response | null> {
    const method = request.method.toUpperCase();
    const key = `${method} ${pathname}`;
    const route = this.httpRoutes.get(key);
    if (!route) return null;
    return route.handler(request);
  }
}
