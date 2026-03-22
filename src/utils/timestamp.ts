/** ISO-8601 timestamp of the current instant. */
export function timestamp(): string {
  return new Date().toISOString();
}
