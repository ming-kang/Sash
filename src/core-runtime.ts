import type { CoreOwnershipSnapshot, CoreState } from "./supervisor.js";

export interface ControllerEndpoint {
  controller: string;
  secret: string;
}
export interface CoreRuntime {
  start(): Promise<{ pid: number; version?: string; tunActive?: boolean }>;
  stop(): Promise<void>;
  restart(): Promise<{ pid: number; version?: string; tunActive?: boolean }>;
  status(): Promise<CoreState>;
  isRunning(): boolean;
  ownedCoreSnapshot(): CoreOwnershipSnapshot | undefined;
  ownsCore(snapshot: CoreOwnershipSnapshot): boolean;
  readonly backend?: "direct" | "service";
  readonly installed?: boolean;
  readonly coreVersion?: string;
  controllerEndpoint?(): ControllerEndpoint;
  validateConfig?(yaml: string): Promise<void>;
  reloadConfig?(configPath: string): Promise<void>;
  refreshProviders?(): Promise<void>;
  close?(): Promise<void>;
  onAvailabilityLoss?(
    callback: (snapshot: CoreOwnershipSnapshot | undefined) => Promise<void>,
  ): void;
}

export class ServiceRequiredError extends Error {
  constructor() {
    super(
      "Windows TUN requires Sash Service. Install the service with an explicit administrator operation before enabling TUN.",
    );
  }
}
export function requireServiceForTun(
  tun: boolean,
  backend: string | undefined,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32" && tun && backend !== "service") throw new ServiceRequiredError();
}
