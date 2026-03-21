export function getLocalEnv(key: string): string | undefined {
  const direct = process.env[key];
  return direct?.trim() || undefined;
}

export function getLocalEnvList(key: string): string[] {
  const value = getLocalEnv(key);
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
