/**
 * Infrastructure domain barrel exports.
 * Re-exports services for shell, filesystem, secrets, telemetry, and runtime.
 */
export { ShellService } from "../shell-service";
export { FilesystemService } from "../filesystem-service";
export { SecretStoreService } from "../secret-store-service";
export { telemetry } from "../telemetry";
export { resolveRuntimePlatform } from "../runtime-platform";
export type { RuntimePlatform } from "../runtime-platform";
