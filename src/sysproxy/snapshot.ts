import { hasExactOwnKeys, isPlainObject } from "../json-shape.js";
import { parseProxyEnable, parseProxyString } from "./common.js";
import type { SystemProxySnapshot } from "./types.js";

const MANAGED_KEYS = ["proxyEnable", "proxyServer", "proxyOverride", "autoConfigUrl"] as const;

/** Parse every journal or OS snapshot before it can authorize a registry write. */
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

export { parseSystemProxySnapshot as windowsSnapshot };

export function isSystemProxySnapshot(value: unknown): value is SystemProxySnapshot {
  try {
    parseSystemProxySnapshot(value);
    return true;
  } catch {
    return false;
  }
}

/** AutoDetect is observed but Windows owns it; never include it in managed comparisons. */
export function snapshotsEquivalent(
  left: SystemProxySnapshot,
  right: SystemProxySnapshot,
): boolean {
  try {
    const a = parseSystemProxySnapshot(left);
    const b = parseSystemProxySnapshot(right);
    return MANAGED_KEYS.every((key) => a[key] === b[key]);
  } catch {
    return false;
  }
}

/** Partial writes may be restored only when every field still matches either owned value. */
export function snapshotsCompatible(
  current: SystemProxySnapshot,
  original: SystemProxySnapshot,
  target: SystemProxySnapshot,
): boolean {
  try {
    const now = parseSystemProxySnapshot(current);
    const before = parseSystemProxySnapshot(original);
    const after = parseSystemProxySnapshot(target);
    return MANAGED_KEYS.every((key) => now[key] === before[key] || now[key] === after[key]);
  } catch {
    return false;
  }
}
