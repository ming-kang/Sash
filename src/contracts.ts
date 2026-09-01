import type { ProfileMeta, ProfilesIndex } from "./profiles.js";
import type { PublicSashSettings } from "./settings.js";
import type { CoreState } from "./supervisor.js";
import type { SystemProxyState } from "./sysproxy.js";

export type { ProfileMeta, ProfilesIndex };

export interface HealthInfo {
  ok: boolean;
  token: string;
  pid: number;
  startedAt: string;
}

export interface CoreStartResult {
  ok: boolean;
  pid: number;
  version?: string;
}

export interface DaemonStatus {
  daemon: {
    pid: number;
    startedAt: string;
    port: number;
  };
  core: CoreState;
  systemProxy: {
    desired: boolean;
    applied: boolean;
    actual?: SystemProxyState;
  };
  settings: PublicSashSettings;
  activeProfile: { id: string; name: string; url: string } | null;
}

export interface ProfileActionResponse {
  ok: boolean;
  profile: ProfileMeta;
  activated: boolean;
  proxyCount?: number;
}

export interface ProfileUpdateResponse {
  ok: boolean;
  profile: ProfileMeta;
  proxyCount?: number;
}

export interface ProfilesResponse extends ProfilesIndex {}

export interface ProfilesUpdateAllResponse {
  ok: boolean;
  updated: number;
  failed: Array<{ id: string; name: string; error: string }>;
  proxyCount?: number;
}
