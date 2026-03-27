/**
 * Common shape for a loaded prompt document snapshot.
 *
 * Every service that reads a markdown prompt file from disk produces an
 * object with these four fields.  Individual services may compose this
 * type into larger aggregate snapshots (e.g. ReflectionPromptSnapshot)
 * but the leaf document shape is always PromptDocumentSnapshot.
 */
export interface PromptDocumentSnapshot {
  text: string;
  path: string;
  loadedAt: string;
  charCount: number;
}
