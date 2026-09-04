import { isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";
import type { SubscriptionUserinfo } from "./mihomo-config.js";
import type { ProfileMeta, ProfilesIndex } from "./profiles.js";
import type { PublicSashSettings } from "./settings.js";
import type { CoreState } from "./supervisor.js";
import type { SystemProxyState } from "./sysproxy.js";

export type { ProfileMeta, ProfilesIndex };

export const WEB_SOCKET_AUTH_PROTOCOL = "sash";
export const WEB_SOCKET_TOKEN_PROTOCOL_PREFIX = "sash-token.";

/* -------------------------------------------------------------------------- */
/* Error envelope                                                              */
/* -------------------------------------------------------------------------- */

/** Machine-readable codes carried by every non-2xx sashd response. */
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
  error: {
    code: ApiErrorCode | (string & {});
    message: string;
  };
}

export function apiErrorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

/** Extract the error envelope from an unknown response body, if present. */
export function parseApiErrorBody(value: unknown): { code: string; message: string } | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.error)) return undefined;
  const { code, message } = value.error;
  if (typeof code !== "string" || typeof message !== "string") return undefined;
  return { code, message };
}

/* -------------------------------------------------------------------------- */
/* Resource bodies (no `ok` envelope: HTTP status carries request success)     */
/* -------------------------------------------------------------------------- */

export interface HealthInfo {
  token: string;
  pid: number;
  startedAt: string;
}

export interface CoreStartResult {
  pid: number;
  version?: string;
  /** Actual Core runtime state; omitted when /configs cannot be verified. */
  tunActive?: boolean;
}

export interface CoreReloadResult {
  proxyCount: number;
  source: "subscription" | "default";
}

export interface ShutdownResult {
  coreWasRunning: boolean;
}

export interface SystemProxyStatusResponse extends SystemProxyState {
  desired: boolean;
  applied: boolean;
  appliedKnown: boolean;
  stateKnown: boolean;
  queryError?: string;
}

export interface DaemonStatus {
  daemon: {
    pid: number;
    startedAt: string;
    port: number;
  };
  revisions: {
    profiles: number;
  };
  core: CoreState;
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

/** Partial-object protocol for PATCH /sash/settings. */
export interface SettingsPatch {
  mixedPort?: number;
  allowLan?: boolean;
  tun?: boolean;
  systemProxy?: boolean;
  daemonPort?: number;
  daemonSecret?: string;
}

export interface SettingsWriteResult {
  restartRequired: boolean;
  settings: PublicSashSettings;
}

export interface SettingsFileContent {
  content: string;
}

export interface ProfilesResponse extends ProfilesIndex {}

export interface ProfileActionResponse {
  profile: ProfileMeta;
  activated: boolean;
  proxyCount?: number;
}

export interface ProfileUpdateResponse {
  profile: ProfileMeta;
  proxyCount?: number;
}

export interface ProfilesUpdateAllResponse {
  /** Business outcome lives in `failed`; the HTTP status is always 200. */
  updated: number;
  failed: Array<{ id: string; name: string; error: string }>;
  proxyCount?: number;
}

export interface ProfileContentResponse {
  name: string;
  content: string;
}

export interface ProfileActivateResponse {
  activeId: string | null;
  proxyCount: number;
}

export interface ProfileRemoveResponse {
  wasActive: boolean;
  proxyCount?: number;
}

export interface ProfileRenameResponse {
  profile: ProfileMeta;
}

/* -------------------------------------------------------------------------- */
/* Parsers                                                                     */
/* -------------------------------------------------------------------------- */

function invalid(contract: string, path: string, expected: string): never {
  throw new TypeError(`${contract} response is invalid: ${path} must be ${expected}`);
}

function objectValue(value: unknown, contract: string, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) invalid(contract, path, "a plain object");
  return value;
}

function required(
  source: Record<string, unknown>,
  key: string,
  contract: string,
  path: string,
): unknown {
  if (!Object.hasOwn(source, key)) invalid(contract, path, "present");
  return source[key];
}

function booleanValue(value: unknown, contract: string, path: string): boolean {
  if (typeof value !== "boolean") invalid(contract, path, "a boolean");
  return value;
}

function stringValue(value: unknown, contract: string, path: string, nonEmpty = false): string {
  if (typeof value !== "string" || (nonEmpty && !value.trim())) {
    invalid(contract, path, nonEmpty ? "a non-empty string" : "a string");
  }
  return value;
}

function finiteNumber(value: unknown, contract: string, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(contract, path, "a finite number");
  }
  return value;
}

function positiveSafeInteger(value: unknown, contract: string, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    invalid(contract, path, "a positive safe integer");
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, contract: string, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(contract, path, "a non-negative safe integer");
  }
  return value;
}

function portValue(value: unknown, contract: string, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    invalid(contract, path, "an integer port from 1 to 65535");
  }
  return value;
}

function timestampValue(value: unknown, contract: string, path: string): string {
  if (!isCanonicalIsoTimestamp(value)) invalid(contract, path, "a canonical ISO timestamp");
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  contract: string,
  path: string,
): string | undefined {
  return Object.hasOwn(source, key) ? stringValue(source[key], contract, path) : undefined;
}

function knownFlag(
  source: Record<string, unknown>,
  key: "appliedKnown" | "stateKnown",
  contract: string,
  path: string,
): boolean {
  return Object.hasOwn(source, key) ? booleanValue(source[key], contract, path) : false;
}

function parseSystemProxyState(value: unknown, contract: string, path: string): SystemProxyState {
  const source = objectValue(value, contract, path);
  const server = optionalString(source, "server", contract, `${path}.server`);
  const details = optionalString(source, "details", contract, `${path}.details`);
  return {
    supported: booleanValue(
      required(source, "supported", contract, `${path}.supported`),
      contract,
      `${path}.supported`,
    ),
    enabled: booleanValue(
      required(source, "enabled", contract, `${path}.enabled`),
      contract,
      `${path}.enabled`,
    ),
    ...(server !== undefined ? { server } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function parseCoreState(value: unknown, contract: string): CoreState {
  const source = objectValue(value, contract, "core");
  const pid = Object.hasOwn(source, "pid")
    ? positiveSafeInteger(source.pid, contract, "core.pid")
    : undefined;
  const startedAt = Object.hasOwn(source, "startedAt")
    ? timestampValue(source.startedAt, contract, "core.startedAt")
    : undefined;
  const healthy = Object.hasOwn(source, "healthy")
    ? booleanValue(source.healthy, contract, "core.healthy")
    : undefined;
  const version = optionalString(source, "version", contract, "core.version");
  const tunActive = Object.hasOwn(source, "tunActive")
    ? booleanValue(source.tunActive, contract, "core.tunActive")
    : undefined;
  return {
    running: booleanValue(
      required(source, "running", contract, "core.running"),
      contract,
      "core.running",
    ),
    ...(pid !== undefined ? { pid } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(healthy !== undefined ? { healthy } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(tunActive !== undefined ? { tunActive } : {}),
  };
}

export function parsePublicSettings(value: unknown): PublicSashSettings {
  const contract = "sashd settings";
  const source = objectValue(value, contract, "settings");
  return {
    mixedPort: portValue(
      required(source, "mixedPort", contract, "settings.mixedPort"),
      contract,
      "settings.mixedPort",
    ),
    controller: stringValue(
      required(source, "controller", contract, "settings.controller"),
      contract,
      "settings.controller",
      true,
    ),
    tun: booleanValue(required(source, "tun", contract, "settings.tun"), contract, "settings.tun"),
    allowLan: booleanValue(
      required(source, "allowLan", contract, "settings.allowLan"),
      contract,
      "settings.allowLan",
    ),
    daemonPort: portValue(
      required(source, "daemonPort", contract, "settings.daemonPort"),
      contract,
      "settings.daemonPort",
    ),
    systemProxy: booleanValue(
      required(source, "systemProxy", contract, "settings.systemProxy"),
      contract,
      "settings.systemProxy",
    ),
  };
}

function parseProfileMeta(value: unknown, contract: string, path: string): ProfileMeta {
  const source = objectValue(value, contract, path);
  const subInfoValue = Object.hasOwn(source, "subInfo")
    ? objectValue(source.subInfo, contract, `${path}.subInfo`)
    : undefined;
  const subInfo: SubscriptionUserinfo | undefined = subInfoValue
    ? {
        upload: finiteNumber(
          required(subInfoValue, "upload", contract, `${path}.subInfo.upload`),
          contract,
          `${path}.subInfo.upload`,
        ),
        download: finiteNumber(
          required(subInfoValue, "download", contract, `${path}.subInfo.download`),
          contract,
          `${path}.subInfo.download`,
        ),
        total: finiteNumber(
          required(subInfoValue, "total", contract, `${path}.subInfo.total`),
          contract,
          `${path}.subInfo.total`,
        ),
        ...(Object.hasOwn(subInfoValue, "expire")
          ? {
              expire: finiteNumber(subInfoValue.expire, contract, `${path}.subInfo.expire`),
            }
          : {}),
      }
    : undefined;
  const homePage = optionalString(source, "homePage", contract, `${path}.homePage`);
  const lastError = optionalString(source, "lastError", contract, `${path}.lastError`);
  return {
    id: stringValue(required(source, "id", contract, `${path}.id`), contract, `${path}.id`, true),
    name: stringValue(required(source, "name", contract, `${path}.name`), contract, `${path}.name`),
    url: stringValue(required(source, "url", contract, `${path}.url`), contract, `${path}.url`),
    intervalHours: nonNegativeSafeInteger(
      required(source, "intervalHours", contract, `${path}.intervalHours`),
      contract,
      `${path}.intervalHours`,
    ),
    createdAt: timestampValue(
      required(source, "createdAt", contract, `${path}.createdAt`),
      contract,
      `${path}.createdAt`,
    ),
    updatedAt: timestampValue(
      required(source, "updatedAt", contract, `${path}.updatedAt`),
      contract,
      `${path}.updatedAt`,
    ),
    ...(subInfo !== undefined ? { subInfo } : {}),
    ...(homePage !== undefined ? { homePage } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
  };
}

function optionalProxyCount(
  source: Record<string, unknown>,
  contract: string,
  path: string,
): { proxyCount?: number } {
  return Object.hasOwn(source, "proxyCount")
    ? { proxyCount: nonNegativeSafeInteger(source.proxyCount, contract, `${path}.proxyCount`) }
    : {};
}

export function parseHealthInfo(value: unknown): HealthInfo {
  const contract = "sashd health";
  const source = objectValue(value, contract, "response");
  return {
    token: stringValue(required(source, "token", contract, "token"), contract, "token", true),
    pid: positiveSafeInteger(required(source, "pid", contract, "pid"), contract, "pid"),
    startedAt: timestampValue(
      required(source, "startedAt", contract, "startedAt"),
      contract,
      "startedAt",
    ),
  };
}

export function parseCoreStartResult(value: unknown): CoreStartResult {
  const contract = "sashd core start";
  const source = objectValue(value, contract, "response");
  const version = optionalString(source, "version", contract, "version");
  const tunActive = Object.hasOwn(source, "tunActive")
    ? booleanValue(source.tunActive, contract, "tunActive")
    : undefined;
  return {
    pid: positiveSafeInteger(required(source, "pid", contract, "pid"), contract, "pid"),
    ...(version !== undefined ? { version } : {}),
    ...(tunActive !== undefined ? { tunActive } : {}),
  };
}

export function parseCoreReloadResult(value: unknown): CoreReloadResult {
  const contract = "sashd core reload";
  const source = objectValue(value, contract, "response");
  const sourceKind = stringValue(
    required(source, "source", contract, "source"),
    contract,
    "source",
  );
  if (sourceKind !== "subscription" && sourceKind !== "default") {
    invalid(contract, "source", `"subscription" or "default"`);
  }
  return {
    proxyCount: nonNegativeSafeInteger(
      required(source, "proxyCount", contract, "proxyCount"),
      contract,
      "proxyCount",
    ),
    source: sourceKind,
  };
}

export function parseShutdownResult(value: unknown): ShutdownResult {
  const contract = "sashd shutdown";
  const source = objectValue(value, contract, "response");
  return {
    coreWasRunning: booleanValue(
      required(source, "coreWasRunning", contract, "coreWasRunning"),
      contract,
      "coreWasRunning",
    ),
  };
}

export function parseSystemProxyStatusResponse(value: unknown): SystemProxyStatusResponse {
  const contract = "sashd system proxy";
  const source = objectValue(value, contract, "response");
  const state = parseSystemProxyState(source, contract, "response");
  const queryError = optionalString(source, "queryError", contract, "queryError");
  return {
    desired: booleanValue(required(source, "desired", contract, "desired"), contract, "desired"),
    applied: booleanValue(required(source, "applied", contract, "applied"), contract, "applied"),
    ...state,
    appliedKnown: knownFlag(source, "appliedKnown", contract, "appliedKnown"),
    stateKnown: knownFlag(source, "stateKnown", contract, "stateKnown"),
    ...(queryError !== undefined ? { queryError } : {}),
  };
}

export function parseSettingsPatch(value: unknown): SettingsPatch {
  const contract = "sashd settings patch";
  const source = objectValue(value, contract, "request");
  const allowed = new Set([
    "mixedPort",
    "allowLan",
    "tun",
    "systemProxy",
    "daemonPort",
    "daemonSecret",
  ]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) invalid(contract, key, "a known settings patch field");
  }
  const patch: SettingsPatch = {};
  if (Object.hasOwn(source, "mixedPort")) {
    patch.mixedPort = portValue(source.mixedPort, contract, "mixedPort");
  }
  if (Object.hasOwn(source, "daemonPort")) {
    patch.daemonPort = portValue(source.daemonPort, contract, "daemonPort");
  }
  if (Object.hasOwn(source, "allowLan")) {
    patch.allowLan = booleanValue(source.allowLan, contract, "allowLan");
  }
  if (Object.hasOwn(source, "tun")) {
    patch.tun = booleanValue(source.tun, contract, "tun");
  }
  if (Object.hasOwn(source, "systemProxy")) {
    patch.systemProxy = booleanValue(source.systemProxy, contract, "systemProxy");
  }
  if (Object.hasOwn(source, "daemonSecret")) {
    patch.daemonSecret = stringValue(source.daemonSecret, contract, "daemonSecret", true);
  }
  return patch;
}

export function parseSettingsWriteResult(value: unknown): SettingsWriteResult {
  const contract = "sashd settings write";
  const source = objectValue(value, contract, "response");
  return {
    restartRequired: booleanValue(
      required(source, "restartRequired", contract, "restartRequired"),
      contract,
      "restartRequired",
    ),
    settings: parsePublicSettings(required(source, "settings", contract, "settings")),
  };
}

export function parseSettingsFileContent(value: unknown): SettingsFileContent {
  const contract = "sashd settings file";
  const source = objectValue(value, contract, "response");
  return {
    content: stringValue(required(source, "content", contract, "content"), contract, "content"),
  };
}

export function parseProfilesIndex(value: unknown): ProfilesIndex {
  const contract = "sashd profiles";
  const source = objectValue(value, contract, "response");
  const activeValue = required(source, "activeId", contract, "activeId");
  const profilesValue = required(source, "profiles", contract, "profiles");
  if (!Array.isArray(profilesValue)) invalid(contract, "profiles", "an array");
  return {
    activeId: activeValue === null ? null : stringValue(activeValue, contract, "activeId", true),
    profiles: profilesValue.map((entry, index) =>
      parseProfileMeta(entry, contract, `profiles[${index}]`),
    ),
  };
}

export function parseProfileActionResponse(value: unknown): ProfileActionResponse {
  const contract = "sashd profile action";
  const source = objectValue(value, contract, "response");
  return {
    profile: parseProfileMeta(
      required(source, "profile", contract, "profile"),
      contract,
      "profile",
    ),
    activated: booleanValue(
      required(source, "activated", contract, "activated"),
      contract,
      "activated",
    ),
    ...optionalProxyCount(source, contract, "response"),
  };
}

export function parseProfileUpdateResponse(value: unknown): ProfileUpdateResponse {
  const contract = "sashd profile update";
  const source = objectValue(value, contract, "response");
  return {
    profile: parseProfileMeta(
      required(source, "profile", contract, "profile"),
      contract,
      "profile",
    ),
    ...optionalProxyCount(source, contract, "response"),
  };
}

export function parseProfilesUpdateAllResponse(value: unknown): ProfilesUpdateAllResponse {
  const contract = "sashd profiles update-all";
  const source = objectValue(value, contract, "response");
  const failedValue = required(source, "failed", contract, "failed");
  if (!Array.isArray(failedValue)) invalid(contract, "failed", "an array");
  return {
    updated: nonNegativeSafeInteger(
      required(source, "updated", contract, "updated"),
      contract,
      "updated",
    ),
    failed: failedValue.map((entry, index) => {
      const path = `failed[${index}]`;
      const failure = objectValue(entry, contract, path);
      return {
        id: stringValue(required(failure, "id", contract, `${path}.id`), contract, `${path}.id`),
        name: stringValue(
          required(failure, "name", contract, `${path}.name`),
          contract,
          `${path}.name`,
        ),
        error: stringValue(
          required(failure, "error", contract, `${path}.error`),
          contract,
          `${path}.error`,
        ),
      };
    }),
    ...optionalProxyCount(source, contract, "response"),
  };
}

export function parseProfileContentResponse(value: unknown): ProfileContentResponse {
  const contract = "sashd profile content";
  const source = objectValue(value, contract, "response");
  return {
    name: stringValue(required(source, "name", contract, "name"), contract, "name"),
    content: stringValue(required(source, "content", contract, "content"), contract, "content"),
  };
}

export function parseProfileActivateResponse(value: unknown): ProfileActivateResponse {
  const contract = "sashd profile activate";
  const source = objectValue(value, contract, "response");
  const activeValue = required(source, "activeId", contract, "activeId");
  return {
    activeId: activeValue === null ? null : stringValue(activeValue, contract, "activeId", true),
    proxyCount: nonNegativeSafeInteger(
      required(source, "proxyCount", contract, "proxyCount"),
      contract,
      "proxyCount",
    ),
  };
}

export function parseProfileRemoveResponse(value: unknown): ProfileRemoveResponse {
  const contract = "sashd profile remove";
  const source = objectValue(value, contract, "response");
  return {
    wasActive: booleanValue(
      required(source, "wasActive", contract, "wasActive"),
      contract,
      "wasActive",
    ),
    ...optionalProxyCount(source, contract, "response"),
  };
}

export function parseProfileRenameResponse(value: unknown): ProfileRenameResponse {
  const contract = "sashd profile rename";
  const source = objectValue(value, contract, "response");
  return {
    profile: parseProfileMeta(
      required(source, "profile", contract, "profile"),
      contract,
      "profile",
    ),
  };
}

export function parseDaemonStatus(value: unknown): DaemonStatus {
  const contract = "sashd status";
  const source = objectValue(value, contract, "response");
  const daemonSource = objectValue(
    required(source, "daemon", contract, "daemon"),
    contract,
    "daemon",
  );
  const revisionsSource = objectValue(
    required(source, "revisions", contract, "revisions"),
    contract,
    "revisions",
  );
  const proxySource = objectValue(
    required(source, "systemProxy", contract, "systemProxy"),
    contract,
    "systemProxy",
  );
  const actual = Object.hasOwn(proxySource, "actual")
    ? parseSystemProxyState(proxySource.actual, contract, "systemProxy.actual")
    : undefined;
  const queryError = optionalString(proxySource, "queryError", contract, "systemProxy.queryError");
  const activeValue = required(source, "activeProfile", contract, "activeProfile");
  const activeProfile =
    activeValue === null
      ? null
      : (() => {
          const active = objectValue(activeValue, contract, "activeProfile");
          return {
            id: stringValue(
              required(active, "id", contract, "activeProfile.id"),
              contract,
              "activeProfile.id",
              true,
            ),
            name: stringValue(
              required(active, "name", contract, "activeProfile.name"),
              contract,
              "activeProfile.name",
            ),
            url: stringValue(
              required(active, "url", contract, "activeProfile.url"),
              contract,
              "activeProfile.url",
            ),
          };
        })();

  return {
    daemon: {
      pid: positiveSafeInteger(
        required(daemonSource, "pid", contract, "daemon.pid"),
        contract,
        "daemon.pid",
      ),
      startedAt: timestampValue(
        required(daemonSource, "startedAt", contract, "daemon.startedAt"),
        contract,
        "daemon.startedAt",
      ),
      port: portValue(
        required(daemonSource, "port", contract, "daemon.port"),
        contract,
        "daemon.port",
      ),
    },
    revisions: {
      profiles: nonNegativeSafeInteger(
        required(revisionsSource, "profiles", contract, "revisions.profiles"),
        contract,
        "revisions.profiles",
      ),
    },
    core: parseCoreState(required(source, "core", contract, "core"), contract),
    systemProxy: {
      desired: booleanValue(
        required(proxySource, "desired", contract, "systemProxy.desired"),
        contract,
        "systemProxy.desired",
      ),
      applied: booleanValue(
        required(proxySource, "applied", contract, "systemProxy.applied"),
        contract,
        "systemProxy.applied",
      ),
      ...(actual !== undefined ? { actual } : {}),
      appliedKnown: knownFlag(proxySource, "appliedKnown", contract, "systemProxy.appliedKnown"),
      stateKnown: knownFlag(proxySource, "stateKnown", contract, "systemProxy.stateKnown"),
      ...(queryError !== undefined ? { queryError } : {}),
    },
    settings: parsePublicSettings(required(source, "settings", contract, "settings")),
    activeProfile,
  };
}
