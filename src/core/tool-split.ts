/**
 * Filters harness tools to exclude those the Claude SDK handles natively.
 */
import type { CoreToolDefinition } from "./types";

/**
 * Return only the harness tools that the Claude SDK does NOT handle natively.
 */
export function filterNativeTools(
  harnessTools: CoreToolDefinition[],
  nativeToolNames: Set<string>,
  suppressedToolNames?: Set<string>,
): CoreToolDefinition[] {
  if (nativeToolNames.size === 0 && (!suppressedToolNames || suppressedToolNames.size === 0)) {
    return harnessTools;
  }
  return harnessTools.filter(
    (t) => !nativeToolNames.has(t.name) && (!suppressedToolNames || !suppressedToolNames.has(t.name)),
  );
}
