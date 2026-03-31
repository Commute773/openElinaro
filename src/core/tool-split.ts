/**
 * Filters harness tools based on a core's manifest.
 *
 * Tools that the core handles natively are excluded so the harness
 * doesn't send duplicate definitions to the model.
 */
import type { CoreManifest, CoreToolDefinition } from "./types";

/**
 * Return only the harness tools that the core does NOT handle natively.
 */
export function splitToolsForCore(
  harnessTools: CoreToolDefinition[],
  manifest: CoreManifest,
): CoreToolDefinition[] {
  const nativeNames = new Set(manifest.nativeTools.map((t) => t.harnessToolName));
  const suppressedNames = new Set(manifest.suppressedTools ?? []);
  if (nativeNames.size === 0 && suppressedNames.size === 0) {
    return harnessTools; // Fast path for cores with no filtering
  }
  return harnessTools.filter((t) => !nativeNames.has(t.name) && !suppressedNames.has(t.name));
}

/**
 * Check whether a given feature is owned by the core (harness should skip).
 */
export function coreOwnsFeature(manifest: CoreManifest, feature: string): boolean {
  return manifest.nativeFeatures.some(
    (f) => f.feature === feature && f.mode === "core_owns",
  );
}

/**
 * Check whether a given feature is shared between core and harness.
 */
export function featureIsShared(manifest: CoreManifest, feature: string): boolean {
  return manifest.nativeFeatures.some(
    (f) => f.feature === feature && f.mode === "shared",
  );
}
