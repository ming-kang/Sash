import { isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";
import type { ProfileMeta, ProfilesIndex } from "./profiles.js";
import type { PublicSashSettings } from "./settings.js";
import type { CoreState } from "./supervisor.js";
import type { SystemProxyState } from "./sysproxy.js";

export type { ProfileMeta, ProfilesIndex };

export const WEB_SOCKET_AUTH_PROTOCOL = "sash";
export const WEB_SOCKET_TOKEN_PROTOCOL_PREFIX = "sash-token.";

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
  /** Actual Core runtime state; omitted when /configs cannot be verified. */
  tunActive?: boolean;
}

export interface MaintenanceShutdownResult {
  ok: true;
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

function parsePublicSettings(value: unknown, contract: string): PublicSashSettings {
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

export function parseHealthInfo(value: unknown): HealthInfo {
  const contract = "sashd health";
  const source = objectValue(value, contract, "response");
  return {
    ok: booleanValue(required(source, "ok", contract, "ok"), contract, "ok"),
    token: stringValue(required(source, "token", contract, "token"), contract, "token", true),
    pid: positiveSafeInteger(required(source, "pid", contract, "pid"), contract, "pid"),
    startedAt: timestampValue(
      required(source, "startedAt", contract, "startedAt"),
      contract,
      "startedAt",
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
    settings: parsePublicSettings(required(source, "settings", contract, "settings"), contract),
    activeProfile,
  };
}
