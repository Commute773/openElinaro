import os from "node:os";
import path from "node:path";

const COMMON_BINARY_PATHS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function uniquePathEntries(entries: Array<string | undefined>) {
  return Array.from(new Set(
    entries
      .flatMap((entry) => (entry ?? "").split(path.delimiter))
      .map((entry) => entry.trim())
      .filter(Boolean),
  ));
}

function buildShellUserBunPaths(shellUser?: string) {
  const normalized = shellUser?.trim();
  if (!normalized) {
    return [];
  }

  return [
    `/Users/${normalized}/.bun/bin`,
    `/home/${normalized}/.bun/bin`,
  ];
}

export function buildOpenElinaroCommandEnvironment(
  overrides?: Record<string, string>,
  options?: { shellUser?: string },
) {
  const shellUser = options?.shellUser?.trim() || overrides?.OPENELINARO_PROFILE_SHELL_USER?.trim();
  const pathEntries = uniquePathEntries([
    path.dirname(process.execPath),
    path.join(os.homedir(), ".bun", "bin"),
    ...buildShellUserBunPaths(shellUser),
    ...COMMON_BINARY_PATHS,
    overrides?.PATH,
    process.env.PATH,
  ]);

  return {
    ...process.env,
    ...(overrides ?? {}),
    PATH: pathEntries.join(path.delimiter),
  };
}
