import { isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";
import { type ProfileMeta, type ProfilesIndex, parseProfileMeta } from "./profile-model.js";
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
export interface HealthInfo {
  token: string;
  pid: number;
  startedAt: string;
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
export interface MutationQueueStatus {
  active: { purpose: string; startedAt: string } | null;
  queued: number;
}
export interface DaemonStatus {
  daemon: { pid: number; bootId: string; startedAt: string; port: number };
  revisions: { state: number; runtime: number };
  mutationQueue: MutationQueueStatus;
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

function object(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be a plain object`);
  return value;
}
function string(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()))
    throw new TypeError(`${name} must be a string${allowEmpty ? "" : " with content"}`);
  return value;
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}
function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function timestamp(value: unknown, name: string): string {
  if (!isCanonicalIsoTimestamp(value)) throw new TypeError(`${name} must be a canonical timestamp`);
  return value;
}
function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  return Object.hasOwn(source, key) ? string(source[key], key, true) : undefined;
}

export function apiErrorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}
export function parseApiErrorBody(value: unknown): { code: string; message: string } | undefined {
  if (
    !isPlainObject(value) ||
    !isPlainObject(value.error) ||
    typeof value.error.code !== "string" ||
    typeof value.error.message !== "string"
  )
    return undefined;
  return { code: value.error.code, message: value.error.message };
}

export function parseHealthInfo(value: unknown): HealthInfo {
  const source = object(value, "health");
  return {
    token: string(source.token, "token"),
    pid: integer(source.pid, "pid", 1),
    startedAt: timestamp(source.startedAt, "startedAt"),
  };
}
export function parseWebBootstrapInfo(value: unknown): WebBootstrapInfo {
  const source = object(value, "bootstrap");
  return {
    token: string(source.token, "token"),
    expiresAt: timestamp(source.expiresAt, "expiresAt"),
  };
}
export function parseWebSessionInfo(value: unknown): WebSessionInfo {
  const source = object(value, "session");
  return {
    token: string(source.token, "token"),
    daemonToken: string(source.daemonToken, "daemonToken"),
  };
}
export function parseCoreStartResult(value: unknown): CoreStartResult {
  const source = object(value, "Core start");
  const version = optionalString(source, "version");
  return { pid: integer(source.pid, "pid", 1), ...(version !== undefined ? { version } : {}) };
}
export function parseCoreUpdateResponse(value: unknown): CoreUpdateResponse {
  return { version: string(object(value, "Core update").version, "version") };
}

export function parsePublicSettings(value: unknown): PublicSashSettings {
  const source = object(value, "settings");
  return {
    mixedPort: integer(source.mixedPort, "mixedPort", 1, 65535),
    controller: string(source.controller, "controller"),
    allowLan: boolean(source.allowLan, "allowLan"),
    daemonPort: integer(source.daemonPort, "daemonPort", 1, 65535),
    systemProxy: boolean(source.systemProxy, "systemProxy"),
  };
}
export function parseSettingsPatch(value: unknown): SettingsPatch {
  const source = object(value, "settings patch");
  for (const key of Object.keys(source)) {
    if (!["mixedPort", "allowLan", "systemProxy", "expectedRevision"].includes(key))
      throw new TypeError(`Unknown settings field: ${key}`);
  }
  return {
    ...(Object.hasOwn(source, "expectedRevision")
      ? { expectedRevision: integer(source.expectedRevision, "expectedRevision") }
      : {}),
    ...(Object.hasOwn(source, "mixedPort")
      ? { mixedPort: integer(source.mixedPort, "mixedPort", 1, 65535) }
      : {}),
    ...(Object.hasOwn(source, "allowLan")
      ? { allowLan: boolean(source.allowLan, "allowLan") }
      : {}),
    ...(Object.hasOwn(source, "systemProxy")
      ? { systemProxy: boolean(source.systemProxy, "systemProxy") }
      : {}),
  };
}
export function parseSettingsWriteResult(value: unknown): SettingsWriteResult {
  const source = object(value, "settings write");
  return {
    revision: integer(source.revision, "revision"),
    restartRequired: boolean(source.restartRequired, "restartRequired"),
    settings: parsePublicSettings(source.settings),
  };
}

function parseSystemProxyState(value: unknown): SystemProxyState {
  const source = object(value, "system proxy");
  const server = optionalString(source, "server");
  const details = optionalString(source, "details");
  return {
    supported: boolean(source.supported, "supported"),
    enabled: boolean(source.enabled, "enabled"),
    ...(server !== undefined ? { server } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}
export function parseSystemProxyStatusResponse(value: unknown): SystemProxyStatusResponse {
  const source = object(value, "system proxy status");
  const queryError = optionalString(source, "queryError");
  return {
    ...parseSystemProxyState(source),
    desired: boolean(source.desired, "desired"),
    applied: boolean(source.applied, "applied"),
    appliedKnown: boolean(source.appliedKnown, "appliedKnown"),
    stateKnown: boolean(source.stateKnown, "stateKnown"),
    ...(queryError !== undefined ? { queryError } : {}),
  };
}

export function parseProfileActionResponse(value: unknown): ProfileActionResponse {
  const source = object(value, "profile action");
  return {
    profile: parseProfileMeta(source.profile),
    activated: boolean(source.activated, "activated"),
  };
}
export function parseProfileUpdateResponse(value: unknown): ProfileUpdateResponse {
  return { profile: parseProfileMeta(object(value, "profile").profile) };
}
export { parseProfileUpdateResponse as parseProfileRenameResponse };
export function parseProfileContentResponse(value: unknown): ProfileContentResponse {
  const source = object(value, "profile content");
  return {
    name: string(source.name, "name"),
    content: string(source.content, "content", true),
    revision: integer(source.revision, "revision", 1),
  };
}
export function parseProfileActivateResponse(value: unknown): ProfileActivateResponse {
  const source = object(value, "profile selection");
  return {
    activeId: source.activeId === null ? null : string(source.activeId, "activeId"),
    proxyCount: integer(source.proxyCount, "proxyCount"),
  };
}
export function parseProfileRemoveResponse(value: unknown): ProfileRemoveResponse {
  return { wasActive: boolean(object(value, "profile removal").wasActive, "wasActive") };
}
export function parseProfilesUpdateAllResponse(value: unknown): ProfilesUpdateAllResponse {
  const source = object(value, "profiles update");
  if (!Array.isArray(source.failed)) throw new TypeError("failed must be an array");
  return {
    updated: integer(source.updated, "updated"),
    failed: source.failed.map((item) => {
      const failure = object(item, "profile error");
      return {
        id: string(failure.id, "id"),
        name: string(failure.name, "name"),
        error: string(failure.error, "error"),
      };
    }),
  };
}

export function parseDaemonStatus(value: unknown): DaemonStatus {
  const source = object(value, "status");
  const daemon = object(source.daemon, "daemon");
  const revisions = object(source.revisions, "revisions");
  const queue = object(source.mutationQueue, "mutationQueue");
  const mutation = queue.active === null ? null : object(queue.active, "mutationQueue.active");
  const core = object(source.core, "core");
  const proxy = object(source.systemProxy, "systemProxy");
  const configuration = object(source.configuration, "configuration");
  const selected =
    source.activeProfile === null ? null : object(source.activeProfile, "activeProfile");
  const applied =
    configuration.appliedProfile === null
      ? null
      : object(configuration.appliedProfile, "appliedProfile");
  const appliedSettings =
    configuration.appliedSettings === null
      ? null
      : object(configuration.appliedSettings, "appliedSettings");
  const version = optionalString(core, "version");
  const queryError = optionalString(proxy, "queryError");
  return {
    daemon: {
      pid: integer(daemon.pid, "daemon.pid", 1),
      bootId: string(daemon.bootId, "daemon.bootId"),
      startedAt: timestamp(daemon.startedAt, "daemon.startedAt"),
      port: integer(daemon.port, "daemon.port", 1, 65535),
    },
    revisions: {
      state: integer(revisions.state, "revisions.state"),
      runtime: integer(revisions.runtime, "revisions.runtime"),
    },
    mutationQueue: {
      queued: integer(queue.queued, "mutationQueue.queued"),
      active: mutation
        ? {
            purpose: string(mutation.purpose, "mutationQueue.active.purpose"),
            startedAt: timestamp(mutation.startedAt, "mutationQueue.active.startedAt"),
          }
        : null,
    },
    core: {
      running: boolean(core.running, "core.running"),
      ...(Object.hasOwn(core, "pid") ? { pid: integer(core.pid, "core.pid", 1) } : {}),
      ...(Object.hasOwn(core, "startedAt")
        ? { startedAt: timestamp(core.startedAt, "core.startedAt") }
        : {}),
      ...(Object.hasOwn(core, "healthy") ? { healthy: boolean(core.healthy, "core.healthy") } : {}),
      ...(version !== undefined ? { version } : {}),
    },
    configuration: {
      pending: boolean(configuration.pending, "configuration.pending"),
      appliedProfile: applied
        ? {
            id: string(applied.id, "appliedProfile.id"),
            revision: integer(applied.revision, "appliedProfile.revision", 1),
            name: string(applied.name, "appliedProfile.name"),
            url: string(applied.url, "appliedProfile.url", true),
          }
        : null,
      appliedSettings: appliedSettings
        ? {
            mixedPort: integer(appliedSettings.mixedPort, "appliedSettings.mixedPort", 1, 65535),
            allowLan: boolean(appliedSettings.allowLan, "appliedSettings.allowLan"),
          }
        : null,
    },
    systemProxy: {
      desired: boolean(proxy.desired, "systemProxy.desired"),
      applied: boolean(proxy.applied, "systemProxy.applied"),
      appliedKnown: boolean(proxy.appliedKnown, "systemProxy.appliedKnown"),
      stateKnown: boolean(proxy.stateKnown, "systemProxy.stateKnown"),
      ...(Object.hasOwn(proxy, "actual") ? { actual: parseSystemProxyState(proxy.actual) } : {}),
      ...(queryError !== undefined ? { queryError } : {}),
    },
    settings: parsePublicSettings(source.settings),
    activeProfile: selected
      ? {
          id: string(selected.id, "activeProfile.id"),
          name: string(selected.name, "activeProfile.name"),
          url: string(selected.url, "activeProfile.url", true),
        }
      : null,
  };
}
