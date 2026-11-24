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

export interface WindowsSystemProxySnapshot {
  version: typeof SYSTEM_PROXY_SNAPSHOT_VERSION;
  platform: "win32";
  proxyEnable: number | null;
  proxyServer: string | null;
  proxyOverride: string | null;
  autoConfigUrl: string | null;
  autoDetect: number | null;
  /**
   * `Internet Settings\Connections` per-connection REG_BINARY blobs keyed
   * by value name, hex-encoded — WinINet rewrites them from the flat values
   * on refresh, so a faithful restore must carry them too.
   */
  connections: Record<string, string>;
}

export type SnapshotValue =
  | string
  | number
  | boolean
  | null
  | SnapshotValue[]
  | { [key: string]: SnapshotValue };

export interface PosixSystemProxySnapshot {
  version: typeof SYSTEM_PROXY_SNAPSHOT_VERSION;
  platform: "darwin" | "linux";
  values: { [key: string]: SnapshotValue };
}

export type SystemProxySnapshot = WindowsSystemProxySnapshot | PosixSystemProxySnapshot;

export interface SystemProxySnapshotCodec {
  parse(value: unknown): SystemProxySnapshot;
  equivalent(left: SystemProxySnapshot, right: SystemProxySnapshot): boolean;
  compatible(
    current: SystemProxySnapshot,
    original: SystemProxySnapshot,
    target: SystemProxySnapshot,
  ): boolean;
  target(options: EnableOptions, original: SystemProxySnapshot): SystemProxySnapshot;
  state(snapshot: SystemProxySnapshot): SystemProxyState;
}

export interface SystemProxyRestoreSkip {
  /** Journal key of the service left untouched (UUID or legacy name). */
  key: string;
  /** Display name the service resolved to when it still exists. */
  service: string;
  reason: "modified" | "removed";
}

export interface SystemProxyRestoreResult {
  /** Journal services that were NOT written: externally modified or gone. */
  skipped: SystemProxyRestoreSkip[];
}

export interface SystemProxyBackend {
  readonly supported: boolean;
  readonly snapshot?: SystemProxySnapshotCodec;
  capture(): Promise<SystemProxySnapshot>;
  apply(snapshot: SystemProxySnapshot): Promise<void>;
  /**
   * Optional journal-scoped restore: decides per recorded service (even
   * offline ones) whether the journal's original values may be written back,
   * skips services whose values were modified outside Sash or removed, and
   * reports what it skipped. When present the manager uses this instead of
   * the whole-snapshot compare/apply path.
   */
  restore?(
    original: SystemProxySnapshot,
    target: SystemProxySnapshot,
  ): Promise<SystemProxyRestoreResult>;
}

export interface WindowsRegistryProxyValues {
  proxyEnable: number | null;
  proxyServer: string | null;
  proxyOverride: string | null;
  autoConfigUrl: string | null;
  autoDetect: number | null;
}
