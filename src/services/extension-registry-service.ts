import fs from "node:fs";
import path from "node:path";
import { ExtensionManifestSchema, type ExtensionManifest, type LoadedExtension } from "../domain/extensions";
import { resolveUserDataPath } from "./runtime-root";

const EXTENSIONS_DIR = "extensions";
const MANIFEST_FILENAME = "extension.json";

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
   * Attempt to load all valid extensions.
   * This is a stub -- dynamic loading is not yet implemented.
   */
  loadAll(): void {
    const valid = this.listValid();
    if (valid.length === 0) {
      console.log("[extensions] No valid extensions to load.");
      return;
    }
    for (const ext of valid) {
      console.log(`[extensions] Extension loading not yet implemented: ${ext.manifest!.id} (${ext.manifest!.version})`);
    }
  }
}
