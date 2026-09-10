import type { CoreUpdateProgress } from "./core-update-progress.js";
import { isPlainObject } from "./json-shape.js";
import type { ProfileMeta, ProfilesIndex } from "./profile-model.js";
import type { PublicSashSettings } from "./settings.js";
import type { CoreState } from "./supervisor.js";
import type { SystemProxyState } from "./sysproxy.js";

export { parseProfilesIndex } from "./profile-model.js";
export type { ProfileMeta, ProfilesIndex };
export const WEB_SOCKET_AUTH_PROTOCOL = "sash";
export const WEB_SOCKET_TOKEN_PROTOCOL_PREFIX = "sash-token.";

export type ApiErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "core_unhealthy"
  | "shutting_down"
  | "unauthorized"
  | "http"
  | "internal";
export interface ApiErrorBody {
  error: { code: string; message: string };
}
export interface InstallationIdentity {
  version?: string;
  installationId?: string;
}
export interface HealthInfo extends InstallationIdentity {
  token: string;
  pid: number;
  startedAt: string;
  webContinuation?: WebContinuationInfo;
}
export interface WebContinuationInfo {
  bootIds: string[];
  expiresAt: string;
}
export interface WebBootstrapInfo {
  token: string;
  expiresAt: string;
}
export interface WebSessionInfo {
  token: string;
  daemonToken: string;
}
export interface CoreStartResult {
  pid: number;
  version?: string;
  alreadyRunning?: boolean;
  mixedPort?: number;
}
export interface CoreUpdateResponse {
  version: string;
}
export interface SettingsPatch {
  expectedRevision?: number;
  mixedPort?: number;
  allowLan?: boolean;
  systemProxy?: boolean;
}
export interface SettingsWriteResult {
  revision: number;
  restartRequired: boolean;
  settings: PublicSashSettings;
}
export interface ProfileActionResponse {
  profile: ProfileMeta;
  activated: boolean;
}
export interface ProfileUpdateResponse {
  profile: ProfileMeta;
}
export interface ProfileRenameResponse {
  profile: ProfileMeta;
}
export interface ProfileContentResponse {
  name: string;
  content: string;
  revision: number;
}
export interface ProfileActivateResponse {
  activeId: string | null;
  proxyCount: number;
}
export interface ProfileRemoveResponse {
  wasActive: boolean;
}
export interface ProfilesResponse extends ProfilesIndex {}
export interface ProfilesUpdateAllResponse {
  updated: number;
  failed: Array<{ id: string; name: string; error: string }>;
}
export interface SystemProxyStatusResponse extends SystemProxyState {
  desired: boolean;
  applied: boolean;
  appliedKnown: boolean;
  stateKnown: boolean;
  queryError?: string;
}
export interface DaemonStatus {
  coreUpdate?: CoreUpdateProgress | null;
  daemon: { pid: number; bootId: string; startedAt: string; port: number } & InstallationIdentity;
  revisions: { state: number; runtime: number };
  core: CoreState;
  configuration: {
    pending: boolean;
    appliedProfile: { id: string; revision: number; name: string; url: string } | null;
    appliedSettings: { mixedPort: number; allowLan: boolean } | null;
  };
  systemProxy: {
    desired: boolean;
    applied: boolean;
    actual?: SystemProxyState;
    appliedKnown: boolean;
    stateKnown: boolean;
    queryError?: string;
  };
  settings: PublicSashSettings;
  activeProfile: { id: string; name: string; url: string } | null;
}

export function apiErrorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

/** Error bodies may arrive as plain text; extract the daemon's code and message when present. */
export function parseApiErrorBody(value: unknown): { code: string; message: string } | undefined {
  if (!isPlainObject(value)) return undefined;
  const error = value.error;
  if (!isPlainObject(error) || typeof error.code !== "string" || typeof error.message !== "string")
    return undefined;
  return { code: error.code, message: error.message };
}
