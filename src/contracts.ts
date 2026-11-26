import type { CoreUpdateProgress, CoreUpdateResult } from "./core-update.js";
import {
  type ErrorPresentation,
  parseErrorPresentation,
  withErrorPresentation,
} from "./error-utils.js";
import type { DownloadTransport } from "./http.js";
import { isPlainObject } from "./json-shape.js";
import type { ProfileMeta, ProfilesIndex } from "./profiles.js";
import type { PublicSashSettings } from "./settings.js";
import type { CoreState } from "./supervisor.js";
import type { SystemProxyState } from "./sysproxy/types.js";
import {
  sameEffectiveTunSettings,
  type TunSettings,
  type TunSettingsPatch,
} from "./tun-settings.js";

export type { ProfileMeta, ProfilesIndex };

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
  error: { code: string; message: string; presentation?: ErrorPresentation };
}
export interface HealthInfo {
  bootId: string;
  pid: number;
  startedAt: string;
  version: string;
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
export type CoreUpdateResponse = CoreUpdateResult;
export interface SettingsPatch {
  expectedRevision?: number;
  mixedPort?: number;
  allowLan?: boolean;
  systemProxy?: boolean;
  tun?: TunSettingsPatch;
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

export type TunHelperAuth = "sudo" | "pkexec";

/** Ambient input like an environment variable ignores invalid values; explicit API input stays strict. */
export function parseTunHelperAuth(value: unknown): TunHelperAuth | undefined {
  return value === "sudo" || value === "pkexec" ? value : undefined;
}

/**
 * How a platform lends the managed Core the privilege TUN needs. None pins a
 * Core version: all act on `layout.coreExe`, the same Core `sash update`
 * replaces.
 */
export type TunPrivilegeMechanism = "service" | "setuid" | "capabilities";

/**
 * - `ready`: TUN can start.
 * - `missing`: nothing is installed or granted.
 * - `stale`: something is installed but cannot serve this data folder — install again.
 * - `unknown`: the platform could not tell.
 */
export type TunPrivilegeState = "ready" | "missing" | "stale" | "unknown";

export type TunHelperStatus =
  | { state: "unsupported" }
  | {
      state: TunPrivilegeState;
      mechanism: TunPrivilegeMechanism;
      /** Why the privilege is not ready, when Sash can tell. */
      detail: string | null;
    };

export interface TunApplyState {
  desired: boolean;
  applied: boolean;
  pending: boolean;
}

/**
 * Whether the saved TUN settings still await an Apply: they differ from what a
 * running Core applied, or nothing has applied them while TUN is saved on.
 */
export function tunPending(saved: TunSettings, applied?: TunSettings): boolean {
  return applied ? !sameEffectiveTunSettings(applied, saved) : saved.enable;
}

export function tunApplyStateFor(saved: TunSettings, applied?: TunSettings): TunApplyState {
  return {
    desired: saved.enable,
    applied: applied?.enable ?? false,
    pending: tunPending(saved, applied),
  };
}

export interface TunGuardReconcileState {
  state: "ok" | "failed" | "unavailable";
  verb: "setup" | "teardown";
  detail: string | null;
  at: string;
}

export interface TunGuardStatus {
  supported: boolean;
  lastReconcile: TunGuardReconcileState | null;
}
export interface ConfigurationPendingChanges {
  profile: boolean;
  mixedPort: boolean;
  allowLan: boolean;
  tun: boolean;
  runtimeUnknown: boolean;
}
export type CoreApplyMethod = "start" | "reload" | "restart";
export interface DaemonStatus {
  coreUpdate?: CoreUpdateProgress | null;
  downloadTransport?: DownloadTransport | null;
  daemon: { pid: number; bootId: string; startedAt: string; port: number; version: string };
  revisions: { state: number; runtime: number };
  core: CoreState;
  configuration: {
    pending: boolean;
    pendingChanges: ConfigurationPendingChanges;
    applyMethod: CoreApplyMethod;
    appliedProfile: { id: string; revision: number; name: string; url: string } | null;
    appliedSettings: { mixedPort: number; allowLan: boolean; tun: TunSettings } | null;
    tunApply: TunApplyState;
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
  tunGuard?: TunGuardStatus;
}

export function tunApplyState(status: DaemonStatus): TunApplyState {
  return { ...status.configuration.tunApply };
}

export function apiErrorBody(
  code: ApiErrorCode,
  message: string,
  presentation?: ErrorPresentation,
): ApiErrorBody {
  return { error: { code, message, ...(presentation ? { presentation } : {}) } };
}

export class SashApiError extends Error {
  readonly presentation?: ErrorPresentation;

  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    presentation?: ErrorPresentation,
  ) {
    super(message);
    this.name = "SashApiError";
    if (presentation) withErrorPresentation(this, presentation);
  }
}

export function parseApiErrorBody(
  value: unknown,
): { code: string; message: string; presentation?: ErrorPresentation } | undefined {
  if (!isPlainObject(value)) return undefined;
  const error = value.error;
  if (!isPlainObject(error) || typeof error.code !== "string" || typeof error.message !== "string")
    return undefined;
  const presentation = parseErrorPresentation(error.presentation);
  return {
    code: error.code,
    message: error.message,
    ...(presentation ? { presentation } : {}),
  };
}
