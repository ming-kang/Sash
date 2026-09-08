export interface SystemProxyState {
  supported: boolean;
  enabled: boolean;
  server?: string;
  details?: string;
}

export interface EnableOptions {
  host?: string;
  port: number;
  bypass?: string[];
}

export const DEFAULT_BYPASS_LIST = [
  "localhost",
  "127.*",
  "10.*",
  "172.16.*",
  "172.17.*",
  "172.18.*",
  "172.19.*",
  "172.20.*",
  "172.21.*",
  "172.22.*",
  "172.23.*",
  "172.24.*",
  "172.25.*",
  "172.26.*",
  "172.27.*",
  "172.28.*",
  "172.29.*",
  "172.30.*",
  "172.31.*",
  "192.168.*",
  "<local>",
];

export const SYSTEM_PROXY_SNAPSHOT_VERSION = 1 as const;

/** Registry values use null to represent a value that did not exist. */
export interface WindowsSystemProxySnapshot {
  version: typeof SYSTEM_PROXY_SNAPSHOT_VERSION;
  platform: "win32";
  proxyEnable: number | null;
  proxyServer: string | null;
  proxyOverride: string | null;
  autoConfigUrl: string | null;
  autoDetect: number | null;
}

/** A JSON-serializable, platform-discriminated snapshot of managed proxy values. */
export type SystemProxySnapshot = WindowsSystemProxySnapshot;

/**
 * Low-level backend. OS capture and apply are asynchronous; pure snapshot
 * construction and comparison remain synchronous and strictly validated.
 */
export interface SystemProxyBackend {
  /** Present on the built-in backends so callers can report unsupported systems. */
  readonly supported?: boolean;
  readonly details?: string;
  capture(): Promise<SystemProxySnapshot>;
  createTarget(original: SystemProxySnapshot, opts: EnableOptions): SystemProxySnapshot;
  apply(snapshot: SystemProxySnapshot): Promise<void>;
  equivalent(a: SystemProxySnapshot, b: SystemProxySnapshot): boolean;
  compatible(
    current: SystemProxySnapshot,
    original: SystemProxySnapshot,
    target: SystemProxySnapshot,
  ): boolean;
  state(snapshot: SystemProxySnapshot): SystemProxyState;
}

export interface WindowsRegistryProxyValues {
  proxyEnable: number | null;
  proxyServer: string | null;
  proxyOverride: string | null;
  autoConfigUrl: string | null;
  autoDetect: number | null;
}
