import { getRuntimeConfig, reloadRuntimeConfig, saveRuntimeConfig, type RuntimeConfig } from "../config/runtime-config";

export function updateTestRuntimeConfig(update: (config: RuntimeConfig) => void) {
  const config = structuredClone(reloadRuntimeConfig()) as RuntimeConfig;
  update(config);
  saveRuntimeConfig(config);
  return getRuntimeConfig();
}
