import { hasExactOwnKeys } from "../json-shape.js";
import {
  compareStrings,
  isPlainObject,
  parseProxyEnable,
  parseProxyString,
  parseServiceName,
  parseSnapshotPort,
} from "./common.js";
import type {
  DarwinAutoProxySetting,
  DarwinProxySetting,
  DarwinServiceProxySnapshot,
  DarwinSystemProxySnapshot,
  LinuxProxyEndpoint,
  LinuxSystemProxySnapshot,
  SystemProxySnapshot,
  WindowsSystemProxySnapshot,
} from "./types.js";
import { SYSTEM_PROXY_SNAPSHOT_VERSION } from "./types.js";

const MAX_NETWORK_SERVICES = 256;

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid system proxy snapshot: ${label} must be a plain object`);
  }
  if (!hasExactOwnKeys(value, keys)) {
    throw new Error(`Invalid system proxy snapshot: ${label} has unexpected fields`);
  }
  return value;
}

function parseDarwinSnapshotSetting(value: unknown, label: string): DarwinProxySetting {
  const record = hasExactKeys(value, ["enabled", "server", "port", "authenticated"], label);
  if (typeof record.enabled !== "boolean") {
    throw new Error(`Invalid system proxy snapshot: ${label}.enabled must be a boolean`);
  }
  if (typeof record.authenticated !== "boolean") {
    throw new Error(`Invalid system proxy snapshot: ${label}.authenticated must be a boolean`);
  }
  return {
    enabled: record.enabled,
    server: parseProxyString(record.server, `${label}.server`),
    port: parseSnapshotPort(record.port, `${label}.port`),
    authenticated: record.authenticated,
  };
}

function parseDarwinAutoSetting(value: unknown, label: string): DarwinAutoProxySetting {
  const record = hasExactKeys(value, ["enabled", "url"], label);
  if (typeof record.enabled !== "boolean") {
    throw new Error(`Invalid system proxy snapshot: ${label}.enabled must be a boolean`);
  }
  return {
    enabled: record.enabled,
    url: parseProxyString(record.url, `${label}.url`),
  };
}

function parseLinuxEndpoint(value: unknown, label: string): LinuxProxyEndpoint {
  const record = hasExactKeys(value, ["host", "port"], label);
  return {
    host: parseProxyString(record.host, `${label}.host`),
    port: parseSnapshotPort(record.port, `${label}.port`),
  };
}

function parseWindowsSnapshot(value: unknown): WindowsSystemProxySnapshot {
  const record = hasExactKeys(
    value,
    [
      "version",
      "platform",
      "proxyEnable",
      "proxyServer",
      "proxyOverride",
      "autoConfigUrl",
      "autoDetect",
    ],
    "Windows snapshot",
  );
  if (record.version !== SYSTEM_PROXY_SNAPSHOT_VERSION || record.platform !== "win32") {
    throw new Error("Invalid system proxy snapshot: expected version 1 Windows snapshot");
  }
  if (record.proxyServer !== null && typeof record.proxyServer !== "string") {
    throw new Error("Invalid system proxy snapshot: proxyServer must be a string or null");
  }
  if (record.proxyOverride !== null && typeof record.proxyOverride !== "string") {
    throw new Error("Invalid system proxy snapshot: proxyOverride must be a string or null");
  }
  if (record.autoConfigUrl !== null && typeof record.autoConfigUrl !== "string") {
    throw new Error("Invalid system proxy snapshot: autoConfigUrl must be a string or null");
  }
  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "win32",
    proxyEnable: parseProxyEnable(record.proxyEnable),
    proxyServer:
      record.proxyServer === null ? null : parseProxyString(record.proxyServer, "proxyServer"),
    proxyOverride:
      record.proxyOverride === null
        ? null
        : parseProxyString(record.proxyOverride, "proxyOverride"),
    autoConfigUrl:
      record.autoConfigUrl === null
        ? null
        : parseProxyString(record.autoConfigUrl, "autoConfigUrl"),
    autoDetect: parseProxyEnable(record.autoDetect),
  };
}

function parseDarwinSnapshot(value: unknown): DarwinSystemProxySnapshot {
  const record = hasExactKeys(value, ["version", "platform", "services"], "macOS snapshot");
  if (record.version !== SYSTEM_PROXY_SNAPSHOT_VERSION || record.platform !== "darwin") {
    throw new Error("Invalid system proxy snapshot: expected version 1 macOS snapshot");
  }
  if (!Array.isArray(record.services)) {
    throw new Error("Invalid system proxy snapshot: services must be an array");
  }
  if (record.services.length > MAX_NETWORK_SERVICES) {
    throw new Error("Invalid system proxy snapshot: services has too many entries");
  }

  const services = record.services.map((value, index): DarwinServiceProxySnapshot => {
    const service = hasExactKeys(
      value,
      ["service", "web", "secureWeb", "socks", "auto"],
      `services[${index}]`,
    );
    return {
      service: parseServiceName(service.service, `services[${index}].service`),
      web: parseDarwinSnapshotSetting(service.web, `services[${index}].web`),
      secureWeb: parseDarwinSnapshotSetting(service.secureWeb, `services[${index}].secureWeb`),
      socks: parseDarwinSnapshotSetting(service.socks, `services[${index}].socks`),
      auto: parseDarwinAutoSetting(service.auto, `services[${index}].auto`),
    };
  });

  services.sort((a, b) => compareStrings(a.service, b.service));
  for (let index = 1; index < services.length; index++) {
    if (services[index - 1]?.service === services[index]?.service) {
      throw new Error("Invalid system proxy snapshot: services must not contain duplicate names");
    }
  }

  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "darwin",
    services,
  };
}

function parseLinuxSnapshot(value: unknown): LinuxSystemProxySnapshot {
  const record = hasExactKeys(
    value,
    [
      "version",
      "platform",
      "mode",
      "autoConfigUrl",
      "httpUseAuthentication",
      "http",
      "https",
      "socks",
    ],
    "Linux snapshot",
  );
  if (record.version !== SYSTEM_PROXY_SNAPSHOT_VERSION || record.platform !== "linux") {
    throw new Error("Invalid system proxy snapshot: expected version 1 Linux snapshot");
  }
  if (record.mode !== "none" && record.mode !== "manual" && record.mode !== "auto") {
    throw new Error("Invalid system proxy snapshot: mode must be none, manual, or auto");
  }
  if (typeof record.httpUseAuthentication !== "boolean") {
    throw new Error("Invalid system proxy snapshot: httpUseAuthentication must be a boolean");
  }
  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "linux",
    mode: record.mode,
    autoConfigUrl: parseProxyString(record.autoConfigUrl, "autoConfigUrl"),
    httpUseAuthentication: record.httpUseAuthentication,
    http: parseLinuxEndpoint(record.http, "http"),
    https: parseLinuxEndpoint(record.https, "https"),
    socks: parseLinuxEndpoint(record.socks, "socks"),
  };
}

/** Parse and canonicalize an untrusted JSON snapshot before using it. */
export function parseSystemProxySnapshot(value: unknown): SystemProxySnapshot {
  if (!isPlainObject(value)) {
    throw new Error("Invalid system proxy snapshot: root must be a plain object");
  }
  switch (value.platform) {
    case "win32":
      return parseWindowsSnapshot(value);
    case "darwin":
      return parseDarwinSnapshot(value);
    case "linux":
      return parseLinuxSnapshot(value);
    default:
      throw new Error("Invalid system proxy snapshot: platform must be win32, darwin, or linux");
  }
}

export function isSystemProxySnapshot(value: unknown): value is SystemProxySnapshot {
  try {
    parseSystemProxySnapshot(value);
    return true;
  } catch {
    return false;
  }
}

export function windowsSnapshot(value: unknown): WindowsSystemProxySnapshot {
  const snapshot = parseSystemProxySnapshot(value);
  if (snapshot.platform !== "win32") {
    throw new Error("Invalid system proxy snapshot: expected Windows snapshot");
  }
  return snapshot;
}

export function darwinSnapshot(value: unknown): DarwinSystemProxySnapshot {
  const snapshot = parseSystemProxySnapshot(value);
  if (snapshot.platform !== "darwin") {
    throw new Error("Invalid system proxy snapshot: expected macOS snapshot");
  }
  return snapshot;
}

export function linuxSnapshot(value: unknown): LinuxSystemProxySnapshot {
  const snapshot = parseSystemProxySnapshot(value);
  if (snapshot.platform !== "linux") {
    throw new Error("Invalid system proxy snapshot: expected Linux snapshot");
  }
  return snapshot;
}

/**
 * Windows rewrites the legacy flat AutoDetect value from the
 * DefaultConnectionSettings blob whenever WinINet refreshes, so Sash can
 * observe but never manage it; ownership comparisons ignore it.
 */
function normalizeForEquivalence(snapshot: SystemProxySnapshot): SystemProxySnapshot {
  return snapshot.platform === "win32" ? { ...snapshot, autoDetect: null } : snapshot;
}

export function snapshotsEquivalent(a: SystemProxySnapshot, b: SystemProxySnapshot): boolean {
  try {
    return (
      JSON.stringify(normalizeForEquivalence(parseSystemProxySnapshot(a))) ===
      JSON.stringify(normalizeForEquivalence(parseSystemProxySnapshot(b)))
    );
  } catch {
    return false;
  }
}

function leafIsCompatible<T>(current: T, original: T, target: T): boolean {
  return current === original || current === target;
}

function sameDarwinServices(a: DarwinSystemProxySnapshot, b: DarwinSystemProxySnapshot): boolean {
  if (a.services.length !== b.services.length) return false;
  for (let index = 0; index < a.services.length; index++) {
    if (a.services[index]?.service !== b.services[index]?.service) return false;
  }
  return true;
}

function darwinSettingIsCompatible(
  current: DarwinProxySetting,
  original: DarwinProxySetting,
  target: DarwinProxySetting,
): boolean {
  return (
    leafIsCompatible(current.enabled, original.enabled, target.enabled) &&
    leafIsCompatible(current.server, original.server, target.server) &&
    leafIsCompatible(current.port, original.port, target.port) &&
    leafIsCompatible(current.authenticated, original.authenticated, target.authenticated)
  );
}

function darwinAutoSettingIsCompatible(
  current: DarwinAutoProxySetting,
  original: DarwinAutoProxySetting,
  target: DarwinAutoProxySetting,
): boolean {
  return (
    leafIsCompatible(current.enabled, original.enabled, target.enabled) &&
    leafIsCompatible(current.url, original.url, target.url)
  );
}

function linuxEndpointIsCompatible(
  current: LinuxProxyEndpoint,
  original: LinuxProxyEndpoint,
  target: LinuxProxyEndpoint,
): boolean {
  return (
    leafIsCompatible(current.host, original.host, target.host) &&
    leafIsCompatible(current.port, original.port, target.port)
  );
}

export function snapshotsCompatible(
  current: SystemProxySnapshot,
  original: SystemProxySnapshot,
  target: SystemProxySnapshot,
): boolean {
  try {
    const parsedCurrent = parseSystemProxySnapshot(current);
    const parsedOriginal = parseSystemProxySnapshot(original);
    const parsedTarget = parseSystemProxySnapshot(target);
    if (
      parsedCurrent.platform !== parsedOriginal.platform ||
      parsedCurrent.platform !== parsedTarget.platform
    ) {
      return false;
    }

    switch (parsedCurrent.platform) {
      case "win32":
        if (parsedOriginal.platform !== "win32" || parsedTarget.platform !== "win32") {
          return false;
        }
        return (
          leafIsCompatible(
            parsedCurrent.proxyEnable,
            parsedOriginal.proxyEnable,
            parsedTarget.proxyEnable,
          ) &&
          leafIsCompatible(
            parsedCurrent.proxyServer,
            parsedOriginal.proxyServer,
            parsedTarget.proxyServer,
          ) &&
          leafIsCompatible(
            parsedCurrent.proxyOverride,
            parsedOriginal.proxyOverride,
            parsedTarget.proxyOverride,
          ) &&
          leafIsCompatible(
            parsedCurrent.autoConfigUrl,
            parsedOriginal.autoConfigUrl,
            parsedTarget.autoConfigUrl,
          )
        );
      case "darwin":
        if (parsedOriginal.platform !== "darwin" || parsedTarget.platform !== "darwin") {
          return false;
        }
        if (
          !sameDarwinServices(parsedCurrent, parsedOriginal) ||
          !sameDarwinServices(parsedCurrent, parsedTarget)
        ) {
          return false;
        }
        for (let index = 0; index < parsedCurrent.services.length; index++) {
          const currentService = parsedCurrent.services[index];
          const originalService = parsedOriginal.services[index];
          const targetService = parsedTarget.services[index];
          if (!currentService || !originalService || !targetService) return false;
          if (
            !darwinSettingIsCompatible(
              currentService.web,
              originalService.web,
              targetService.web,
            ) ||
            !darwinSettingIsCompatible(
              currentService.secureWeb,
              originalService.secureWeb,
              targetService.secureWeb,
            ) ||
            !darwinSettingIsCompatible(
              currentService.socks,
              originalService.socks,
              targetService.socks,
            ) ||
            !darwinAutoSettingIsCompatible(
              currentService.auto,
              originalService.auto,
              targetService.auto,
            )
          ) {
            return false;
          }
        }
        return true;
      case "linux":
        if (parsedOriginal.platform !== "linux" || parsedTarget.platform !== "linux") {
          return false;
        }
        return (
          leafIsCompatible(parsedCurrent.mode, parsedOriginal.mode, parsedTarget.mode) &&
          leafIsCompatible(
            parsedCurrent.autoConfigUrl,
            parsedOriginal.autoConfigUrl,
            parsedTarget.autoConfigUrl,
          ) &&
          leafIsCompatible(
            parsedCurrent.httpUseAuthentication,
            parsedOriginal.httpUseAuthentication,
            parsedTarget.httpUseAuthentication,
          ) &&
          linuxEndpointIsCompatible(parsedCurrent.http, parsedOriginal.http, parsedTarget.http) &&
          linuxEndpointIsCompatible(
            parsedCurrent.https,
            parsedOriginal.https,
            parsedTarget.https,
          ) &&
          linuxEndpointIsCompatible(parsedCurrent.socks, parsedOriginal.socks, parsedTarget.socks)
        );
    }
  } catch {
    return false;
  }
}
