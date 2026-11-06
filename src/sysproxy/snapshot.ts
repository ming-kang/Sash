import { hasExactOwnKeys, isPlainObject } from "../json-shape.js";
import { parseProxyEnable, parseProxyString } from "./common.js";
import type { SystemProxySnapshot } from "./types.js";

const MANAGED_KEYS = ["proxyEnable", "proxyServer", "proxyOverride", "autoConfigUrl"] as const;

/** Normalize an untrusted persisted snapshot before it can authorize a registry write. */
export function parseSystemProxySnapshot(value: unknown): SystemProxySnapshot {
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, ["version", "platform", ...MANAGED_KEYS, "autoDetect"]) ||
    value.version !== 1 ||
    value.platform !== "win32"
  ) {
    throw new Error("Invalid system proxy snapshot: expected a version 1 Windows snapshot");
  }
  return {
    version: 1,
    platform: "win32",
    proxyEnable: parseProxyEnable(value.proxyEnable),
    proxyServer:
      value.proxyServer === null ? null : parseProxyString(value.proxyServer, "proxyServer"),
    proxyOverride:
      value.proxyOverride === null ? null : parseProxyString(value.proxyOverride, "proxyOverride"),
    autoConfigUrl:
      value.autoConfigUrl === null ? null : parseProxyString(value.autoConfigUrl, "autoConfigUrl"),
    autoDetect: parseProxyEnable(value.autoDetect),
  };
}

/** AutoDetect is observed but Windows owns it; never include it in managed comparisons. */
export function snapshotsEquivalent(
  left: SystemProxySnapshot,
  right: SystemProxySnapshot,
): boolean {
  return MANAGED_KEYS.every((key) => left[key] === right[key]);
}

/** Partial writes may be restored only when every field still matches either owned value. */
export function snapshotsCompatible(
  current: SystemProxySnapshot,
  original: SystemProxySnapshot,
  target: SystemProxySnapshot,
): boolean {
  return MANAGED_KEYS.every(
    (key) => current[key] === original[key] || current[key] === target[key],
  );
}
