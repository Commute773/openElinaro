/** Rough token estimate: ~4 chars per token. */
export function approximateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Count lines in a string. Returns 0 for empty/falsy input. */
export function countLines(content: string): number {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

/** Normalize an unknown value to a trimmed string or null. */
export function normalizeString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}
