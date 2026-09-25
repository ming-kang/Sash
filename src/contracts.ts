import type { CoreUpdateProgress, CoreUpdateResult } from "./core-update.js";
import type { DownloadTransport } from "./http.js";
import { isPlainObject } from "./json-shape.js";
import type { ProfileMeta, ProfilesIndex } from "./profiles.js";
import type { PublicSashSettings } from "./settings.js";
import type { CoreState } from "./supervisor.js";
import type { SystemProxyState } from "./sysproxy/types.js";

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
export interface HealthInfo {
  token: string;
  pid: number;
  startedAt: string;
  version: string;
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

export type RoutingMode = "rule" | "global" | "direct";

export function isRoutingMode(value: unknown): value is RoutingMode {
  return value === "rule" || value === "global" || value === "direct";
}
/** The Core update result as it travels over the local API. */
export type CoreUpdateResponse = CoreUpdateResult;
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
  applied: boolean;
}
export interface ProfileUpdateResponse {
  profile: ProfileMeta;
  applied: boolean;
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
  applied: boolean;
}
export interface ProfileRemoveResponse {
  wasActive: boolean;
  applied: boolean;
}
export interface ProfilesResponse extends ProfilesIndex {}
export interface ProfilesUpdateAllResponse {
  updated: number;
  failed: Array<{ id: string; name: string; error: string }>;
  applied: boolean;
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
  /** null means direct with mirror fallback. */
  downloadTransport?: DownloadTransport | null;
  daemon: { pid: number; bootId: string; startedAt: string; port: number; version: string };
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

export class SashApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "SashApiError";
  }
}

/** Error bodies may arrive as plain text; extract the daemon's code and message when present. */
export function parseApiErrorBody(value: unknown): { code: string; message: string } | undefined {
  if (!isPlainObject(value)) return undefined;
  const error = value.error;
  if (!isPlainObject(error) || typeof error.code !== "string" || typeof error.message !== "string")
    return undefined;
  return { code: error.code, message: error.message };
}
