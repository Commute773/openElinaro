export type SupportedRuntimeOs = "darwin" | "linux";
export type ServiceManagerKind = "launchd" | "systemd";

export interface RuntimePlatform {
  os: SupportedRuntimeOs;
  serviceManager: ServiceManagerKind;
  managedServiceName: string;
  serviceStdoutLogFile: string;
  serviceStderrLogFile: string;
  supportsMedia: boolean;
}

export function resolveRuntimePlatform(platform: NodeJS.Platform = process.platform): RuntimePlatform {
  switch (platform) {
    case "darwin":
      return {
        os: "darwin",
        serviceManager: "launchd",
        managedServiceName: "com.openelinaro.bot",
        serviceStdoutLogFile: "service.stdout.log",
        serviceStderrLogFile: "service.stderr.log",
        supportsMedia: true,
      };
    case "linux":
      return {
        os: "linux",
        serviceManager: "systemd",
        managedServiceName: "openelinaro.service",
        serviceStdoutLogFile: "service.stdout.log",
        serviceStderrLogFile: "service.stderr.log",
        supportsMedia: false,
      };
    default:
      throw new Error(`Unsupported runtime platform: ${platform}`);
  }
}

export function isRunningInsideManagedService(environment: NodeJS.ProcessEnv = process.env) {
  return Boolean(environment.OPENELINARO_SERVICE_ROOT_DIR?.trim());
}
