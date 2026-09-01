import { execFileSync } from "node:child_process";

/**
 * Platform-level system proxy backend.
 *
 * Higher-level ownership and recovery policy lives in system-proxy-manager.ts.
 * This module only captures, compares, and applies the settings it manages.
 */

export interface SystemProxyState {
  supported: boolean;
  enabled: boolean;
  server?: string;
  details?: string;
}

export interface EnableOptions {
  host?: string;
  port: number;
  bypass?: string[];
}

export const DEFAULT_BYPASS_LIST = [
  "localhost",
  "127.*",
  "10.*",
  "172.16.*",
  "172.17.*",
  "172.18.*",
  "172.19.*",
  "172.20.*",
  "172.21.*",
  "172.22.*",
  "172.23.*",
  "172.24.*",
  "172.25.*",
  "172.26.*",
  "172.27.*",
  "172.28.*",
  "172.29.*",
  "172.30.*",
  "172.31.*",
  "192.168.*",
  "<local>",
];

export const SYSTEM_PROXY_SNAPSHOT_VERSION = 1 as const;

export type SystemProxyPlatform = "win32" | "darwin" | "linux";

/** Registry values use null to represent a value that did not exist. */
export interface WindowsSystemProxySnapshot {
  version: typeof SYSTEM_PROXY_SNAPSHOT_VERSION;
  platform: "win32";
  proxyEnable: number | null;
  proxyServer: string | null;
  proxyOverride: string | null;
  autoConfigUrl: string | null;
  autoDetect: number | null;
}

export interface DarwinProxySetting {
  enabled: boolean;
  server: string;
  port: number;
  authenticated: boolean;
}

export interface DarwinAutoProxySetting {
  enabled: boolean;
  url: string;
}

export interface DarwinServiceProxySnapshot {
  service: string;
  web: DarwinProxySetting;
  secureWeb: DarwinProxySetting;
  socks: DarwinProxySetting;
  auto: DarwinAutoProxySetting;
}

export interface DarwinSystemProxySnapshot {
  version: typeof SYSTEM_PROXY_SNAPSHOT_VERSION;
  platform: "darwin";
  services: DarwinServiceProxySnapshot[];
}

export type LinuxProxyMode = "none" | "manual" | "auto";

export interface LinuxProxyEndpoint {
  host: string;
  port: number;
}

export interface LinuxSystemProxySnapshot {
  version: typeof SYSTEM_PROXY_SNAPSHOT_VERSION;
  platform: "linux";
  mode: LinuxProxyMode;
  autoConfigUrl: string;
  httpUseAuthentication: boolean;
  http: LinuxProxyEndpoint;
  https: LinuxProxyEndpoint;
  socks: LinuxProxyEndpoint;
}

/** A JSON-serializable, platform-discriminated snapshot of managed proxy values. */
export type SystemProxySnapshot =
  | WindowsSystemProxySnapshot
  | DarwinSystemProxySnapshot
  | LinuxSystemProxySnapshot;

/**
 * Synchronous low-level backend. Every snapshot passed to apply/state is
 * validated before it can become process arguments or OS configuration.
 */
export interface SystemProxyBackend {
  /** Present on the built-in backends so callers can report unsupported systems. */
  readonly supported?: boolean;
  readonly details?: string;
  capture(): SystemProxySnapshot;
  createTarget(original: SystemProxySnapshot, opts: EnableOptions): SystemProxySnapshot;
  apply(snapshot: SystemProxySnapshot): void;
  equivalent(a: SystemProxySnapshot, b: SystemProxySnapshot): boolean;
  compatible(
    current: SystemProxySnapshot,
    original: SystemProxySnapshot,
    target: SystemProxySnapshot,
  ): boolean;
  state(snapshot: SystemProxySnapshot): SystemProxyState;
}

const WIN_REG_PATH = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const MAX_PROXY_STRING_LENGTH = 4096;
const MAX_SERVICE_NAME_LENGTH = 512;
const MAX_NETWORK_SERVICES = 256;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid system proxy snapshot: ${label} must be a plain object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw new Error(`Invalid system proxy snapshot: ${label} has unexpected fields`);
  }
  return value;
}

function parseSnapshotString(value: unknown, label: string, allowEmpty = true): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid system proxy snapshot: ${label} must be a string`);
  }
  if ((!allowEmpty && value.length === 0) || value.length > MAX_PROXY_STRING_LENGTH) {
    throw new Error(`Invalid system proxy snapshot: ${label} has an invalid length`);
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`Invalid system proxy snapshot: ${label} contains control characters`);
    }
  }
  return value;
}

function parseServiceName(value: unknown, label: string): string {
  const service = parseSnapshotString(value, label, false);
  if (service.length > MAX_SERVICE_NAME_LENGTH) {
    throw new Error(`Invalid system proxy snapshot: ${label} has an invalid length`);
  }
  return service;
}

function parseSnapshotPort(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`Invalid system proxy snapshot: ${label} must be an integer from 0 to 65535`);
  }
  return value;
}

function parseProxyEnable(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(
      "Invalid system proxy snapshot: proxyEnable must be null or an unsigned 32-bit integer",
    );
  }
  return value;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
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
    server: parseSnapshotString(record.server, `${label}.server`),
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
    url: parseSnapshotString(record.url, `${label}.url`),
  };
}

function parseLinuxEndpoint(value: unknown, label: string): LinuxProxyEndpoint {
  const record = hasExactKeys(value, ["host", "port"], label);
  return {
    host: parseSnapshotString(record.host, `${label}.host`),
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
      record.proxyServer === null ? null : parseSnapshotString(record.proxyServer, "proxyServer"),
    proxyOverride:
      record.proxyOverride === null
        ? null
        : parseSnapshotString(record.proxyOverride, "proxyOverride"),
    autoConfigUrl:
      record.autoConfigUrl === null
        ? null
        : parseSnapshotString(record.autoConfigUrl, "autoConfigUrl"),
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
    autoConfigUrl: parseSnapshotString(record.autoConfigUrl, "autoConfigUrl"),
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

function windowsSnapshot(value: unknown): WindowsSystemProxySnapshot {
  const snapshot = parseSystemProxySnapshot(value);
  if (snapshot.platform !== "win32") {
    throw new Error("Invalid system proxy snapshot: expected Windows snapshot");
  }
  return snapshot;
}

function darwinSnapshot(value: unknown): DarwinSystemProxySnapshot {
  const snapshot = parseSystemProxySnapshot(value);
  if (snapshot.platform !== "darwin") {
    throw new Error("Invalid system proxy snapshot: expected macOS snapshot");
  }
  return snapshot;
}

function linuxSnapshot(value: unknown): LinuxSystemProxySnapshot {
  const snapshot = parseSystemProxySnapshot(value);
  if (snapshot.platform !== "linux") {
    throw new Error("Invalid system proxy snapshot: expected Linux snapshot");
  }
  return snapshot;
}

function snapshotsEquivalent(a: SystemProxySnapshot, b: SystemProxySnapshot): boolean {
  try {
    return (
      JSON.stringify(parseSystemProxySnapshot(a)) === JSON.stringify(parseSystemProxySnapshot(b))
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

function snapshotsCompatible(
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
          ) &&
          leafIsCompatible(
            parsedCurrent.autoDetect,
            parsedOriginal.autoDetect,
            parsedTarget.autoDetect,
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

export function isSystemProxySupported(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32" || platform === "darwin") return true;
  if (platform !== "linux") return false;
  try {
    execFileSync("which", ["gsettings"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function runCmd(cmd: string, args: string[], timeoutMs = 5000): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizeEnableOptions(opts: EnableOptions): {
  host: string;
  port: number;
  bypass: string[];
} {
  if (!isPlainObject(opts)) {
    throw new Error("System proxy options must be a plain object");
  }
  if (
    typeof opts.port !== "number" ||
    !Number.isInteger(opts.port) ||
    opts.port < 1 ||
    opts.port > 65_535
  ) {
    throw new Error("System proxy port must be an integer from 1 to 65535");
  }
  const host =
    opts.host === undefined ? "127.0.0.1" : parseSnapshotString(opts.host, "host", false);
  const rawBypass = opts.bypass ?? DEFAULT_BYPASS_LIST;
  if (!Array.isArray(rawBypass)) {
    throw new Error("System proxy bypass list must be an array of strings");
  }
  const bypass = rawBypass.map((entry, index) =>
    parseSnapshotString(entry, `bypass[${index}]`, false),
  );
  if (formatWindowsBypass(bypass).length > MAX_PROXY_STRING_LENGTH) {
    throw new Error("System proxy bypass list is too long");
  }
  return { host, port: opts.port, bypass };
}

function formatHostPort(host: string, port: number): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
}

/* ========================================================================== */
/* Windows                                                                    */
/* ========================================================================== */

export function formatWindowsBypass(list: string[] = DEFAULT_BYPASS_LIST): string {
  return list.join(";");
}

export interface WindowsRegistryProxyValues {
  proxyEnable: number | null;
  proxyServer: string | null;
  proxyOverride: string | null;
  autoConfigUrl: string | null;
  autoDetect: number | null;
}

/**
 * Parse the managed registry values from `reg query` output. REG_SZ data is
 * captured as the remainder of its line so bypass lists and servers may contain spaces.
 */
export function parseWindowsRegistryProxyValues(output: string): WindowsRegistryProxyValues {
  let proxyEnable: number | null = null;
  let proxyServer: string | null = null;
  let proxyOverride: string | null = null;
  let autoConfigUrl: string | null = null;
  let autoDetect: number | null = null;
  const seen = new Set<string>();

  for (const line of output.split(/\n/)) {
    const match = line.match(
      /^\s*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL|AutoDetect)\s+(REG_[A-Z0-9_]+)(?:\s+(.*))?\s*$/i,
    );
    if (!match) continue;

    const name = match[1]?.toLowerCase();
    const type = match[2]?.toUpperCase();
    const rawValue = match[3] ?? "";
    if (!name || !type) continue;
    if (seen.has(name)) {
      throw new Error(`Invalid Windows registry output: duplicate ${name} value`);
    }
    seen.add(name);

    if (name === "proxyenable" || name === "autodetect") {
      if (type !== "REG_DWORD") {
        throw new Error(`Invalid Windows registry output: ${name} must be REG_DWORD`);
      }
      const text = rawValue.trim();
      if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(text)) {
        throw new Error(`Invalid Windows registry output: ${name} has an invalid DWORD value`);
      }
      const value = Number.parseInt(text, text.toLowerCase().startsWith("0x") ? 16 : 10);
      if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
        throw new Error(`Invalid Windows registry output: ${name} is outside DWORD range`);
      }
      if (name === "proxyenable") proxyEnable = value;
      else autoDetect = value;
      continue;
    }

    if (type !== "REG_SZ") {
      throw new Error(`Invalid Windows registry output: ${name} must be REG_SZ`);
    }
    const value = parseSnapshotString(rawValue.replace(/\r$/, ""), name);
    if (name === "proxyserver") {
      proxyServer = value;
    } else if (name === "proxyoverride") {
      proxyOverride = value;
    } else {
      autoConfigUrl = value;
    }
  }

  return { proxyEnable, proxyServer, proxyOverride, autoConfigUrl, autoDetect };
}

/** Legacy display parser retained for existing callers. */
export function parseWindowsRegQuery(output: string): { enabled: boolean; server?: string } {
  try {
    const values = parseWindowsRegistryProxyValues(output);
    const enabled = values.proxyEnable === 1;
    return values.proxyServer === null || values.proxyServer.length === 0
      ? { enabled }
      : { enabled, server: values.proxyServer };
  } catch {
    return { enabled: false };
  }
}

function captureWindowsSnapshot(): WindowsSystemProxySnapshot {
  const values = parseWindowsRegistryProxyValues(runCmd("reg.exe", ["query", WIN_REG_PATH]));
  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "win32",
    proxyEnable: values.proxyEnable,
    proxyServer: values.proxyServer,
    proxyOverride: values.proxyOverride,
    autoConfigUrl: values.autoConfigUrl,
    autoDetect: values.autoDetect,
  };
}

function refreshWindowsWinINet(): void {
  const script = [
    '$signature = @"',
    '[DllImport("wininet.dll", SetLastError = true)]',
    "public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);",
    '"@',
    "$type = Add-Type -MemberDefinition $signature -Name WinINet -Namespace Interop -PassThru -ErrorAction SilentlyContinue",
    "if ($type) {",
    "  [Interop.WinINet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null",
    "  [Interop.WinINet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null",
    "}",
  ].join("\n");
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 5000,
      stdio: "ignore",
    });
  } catch {
    // The registry values are authoritative even if the notification cannot run.
  }
}

type WindowsValueName =
  | "ProxyEnable"
  | "ProxyServer"
  | "ProxyOverride"
  | "AutoConfigURL"
  | "AutoDetect";

function windowsSnapshotValue(
  snapshot: WindowsSystemProxySnapshot,
  name: WindowsValueName,
): number | string | null {
  switch (name) {
    case "ProxyEnable":
      return snapshot.proxyEnable;
    case "ProxyServer":
      return snapshot.proxyServer;
    case "ProxyOverride":
      return snapshot.proxyOverride;
    case "AutoConfigURL":
      return snapshot.autoConfigUrl;
    case "AutoDetect":
      return snapshot.autoDetect;
  }
}

function deleteWindowsValue(name: WindowsValueName): void {
  try {
    runCmd("reg.exe", ["delete", WIN_REG_PATH, "/v", name, "/f"]);
  } catch (err) {
    // A failed delete is harmless only when a fresh, strictly parsed snapshot
    // proves the value is already absent. Do not infer absence from stderr.
    const current = captureWindowsSnapshot();
    if (windowsSnapshotValue(current, name) !== null) throw err;
  }
}

function applyWindowsValue(
  name: WindowsValueName,
  type: "REG_DWORD" | "REG_SZ",
  value: number | string | null,
): void {
  if (value === null) {
    deleteWindowsValue(name);
    return;
  }
  runCmd("reg.exe", ["add", WIN_REG_PATH, "/v", name, "/t", type, "/d", String(value), "/f"]);
}

function applyWindowsSnapshot(value: unknown): void {
  const snapshot = windowsSnapshot(value);
  try {
    // Disable/restore PAC metadata before enabling the manual proxy. Keep
    // ProxyEnable last so partially-written targets do not become active first.
    applyWindowsValue("AutoConfigURL", "REG_SZ", snapshot.autoConfigUrl);
    applyWindowsValue("AutoDetect", "REG_DWORD", snapshot.autoDetect);
    applyWindowsValue("ProxyServer", "REG_SZ", snapshot.proxyServer);
    applyWindowsValue("ProxyOverride", "REG_SZ", snapshot.proxyOverride);
    applyWindowsValue("ProxyEnable", "REG_DWORD", snapshot.proxyEnable);
  } finally {
    refreshWindowsWinINet();
  }
}

function createWindowsTarget(
  original: SystemProxySnapshot,
  opts: EnableOptions,
): WindowsSystemProxySnapshot {
  windowsSnapshot(original);
  const normalized = normalizeEnableOptions(opts);
  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "win32",
    proxyEnable: 1,
    proxyServer: formatHostPort(normalized.host, normalized.port),
    proxyOverride: formatWindowsBypass(normalized.bypass),
    autoConfigUrl: null,
    autoDetect: 0,
  };
}

function windowsState(value: unknown): SystemProxyState {
  const snapshot = windowsSnapshot(value);
  const enabled = snapshot.proxyEnable === 1;
  if (enabled) {
    return snapshot.proxyServer
      ? { supported: true, enabled: true, server: snapshot.proxyServer }
      : { supported: true, enabled: true, details: "manual proxy has no server" };
  }
  if (snapshot.autoConfigUrl || snapshot.autoDetect === 1) {
    return {
      supported: true,
      enabled: true,
      ...(snapshot.autoConfigUrl ? { server: snapshot.autoConfigUrl } : {}),
      details: snapshot.autoConfigUrl
        ? "automatic proxy configuration is enabled"
        : "automatic proxy detection is enabled",
    };
  }
  return { supported: true, enabled: false };
}

/* ========================================================================== */
/* macOS                                                                      */
/* ========================================================================== */

export function parseDarwinServices(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("*") && !line.startsWith("An asterisk"));
}

interface ParsedDarwinProxyOutput {
  enabled?: boolean;
  server?: string;
  port?: number;
  authenticated?: boolean;
}

function parseDarwinProxyOutput(output: string): ParsedDarwinProxyOutput {
  const enabledText = output
    .match(/^Enabled:\s*(.*?)\s*$/im)?.[1]
    ?.trim()
    .toLowerCase();
  const serverMatch = output.match(/^Server:\s*(.*?)\s*$/im);
  const portText = output.match(/^Port:\s*(.*?)\s*$/im)?.[1]?.trim();
  const authenticatedText = output
    .match(/^Authenticated Proxy Enabled:\s*(.*?)\s*$/im)?.[1]
    ?.trim()
    .toLowerCase();

  let enabled: boolean | undefined;
  if (enabledText === "yes") enabled = true;
  if (enabledText === "no") enabled = false;

  let port: number | undefined;
  if (portText !== undefined && /^\d+$/.test(portText)) {
    const parsed = Number.parseInt(portText, 10);
    if (parsed >= 0 && parsed <= 65_535) port = parsed;
  }

  let authenticated: boolean | undefined;
  if (authenticatedText === "yes" || authenticatedText === "on" || authenticatedText === "1") {
    authenticated = true;
  }
  if (authenticatedText === "no" || authenticatedText === "off" || authenticatedText === "0") {
    authenticated = false;
  }

  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(serverMatch === null ? {} : { server: (serverMatch[1] ?? "").trim() }),
    ...(port === undefined ? {} : { port }),
    ...(authenticated === undefined ? {} : { authenticated }),
  };
}

/** Legacy display parser retained for existing callers. */
export function parseDarwinGetWebProxy(output: string): { enabled: boolean; server?: string } {
  const parsed = parseDarwinProxyOutput(output);
  const enabled = parsed.enabled === true;
  if (!enabled || !parsed.server || !parsed.port) return { enabled };
  return { enabled, server: `${parsed.server}:${parsed.port}` };
}

/** Parse the complete networksetup proxy record needed for lossless recovery. */
export function parseDarwinProxySetting(output: string): DarwinProxySetting {
  const parsed = parseDarwinProxyOutput(output);
  if (parsed.enabled === undefined) {
    throw new Error("Invalid macOS networksetup output: missing Enabled state");
  }
  if (parsed.server === undefined) {
    throw new Error("Invalid macOS networksetup output: missing Server value");
  }
  if (parsed.port === undefined) {
    throw new Error("Invalid macOS networksetup output: missing or invalid Port value");
  }
  if (parsed.authenticated === undefined) {
    throw new Error("Invalid macOS networksetup output: missing authenticated proxy state");
  }
  return {
    enabled: parsed.enabled,
    server: parseSnapshotString(parsed.server, "macOS proxy server"),
    port: parsed.port,
    authenticated: parsed.authenticated,
  };
}

export function parseDarwinAutoProxySetting(output: string): DarwinAutoProxySetting {
  const enabledText = output
    .match(/^Enabled:\s*(.*?)\s*$/im)?.[1]
    ?.trim()
    .toLowerCase();
  const urlText = output.match(/^URL:\s*(.*?)\s*$/im)?.[1]?.trim();
  if (enabledText !== "yes" && enabledText !== "no") {
    throw new Error("Invalid macOS networksetup output: missing automatic proxy state");
  }
  if (urlText === undefined) {
    throw new Error("Invalid macOS networksetup output: missing automatic proxy URL");
  }
  return {
    enabled: enabledText === "yes",
    url: parseSnapshotString(urlText === "(null)" ? "" : urlText, "macOS automatic proxy URL"),
  };
}

function listDarwinServices(): string[] {
  const services = parseDarwinServices(runCmd("networksetup", ["-listallnetworkservices"]));
  const canonical = services.map((service, index) =>
    parseServiceName(service, `network service ${index}`),
  );
  canonical.sort(compareStrings);
  for (let index = 1; index < canonical.length; index++) {
    if (canonical[index - 1] === canonical[index]) {
      throw new Error("Invalid macOS networksetup output: duplicate network service name");
    }
  }
  return canonical;
}

type DarwinProxyKind = "web" | "secureWeb" | "socks";

const DARWIN_PROXY_COMMANDS: ReadonlyArray<{
  kind: DarwinProxyKind;
  set: string;
  setState: string;
  get: string;
}> = [
  {
    kind: "web",
    set: "-setwebproxy",
    setState: "-setwebproxystate",
    get: "-getwebproxy",
  },
  {
    kind: "secureWeb",
    set: "-setsecurewebproxy",
    setState: "-setsecurewebproxystate",
    get: "-getsecurewebproxy",
  },
  {
    kind: "socks",
    set: "-setsocksfirewallproxy",
    setState: "-setsocksfirewallproxystate",
    get: "-getsocksfirewallproxy",
  },
];

function captureDarwinSnapshot(): DarwinSystemProxySnapshot {
  const services = listDarwinServices().map((service): DarwinServiceProxySnapshot => {
    const settings = new Map<DarwinProxyKind, DarwinProxySetting>();
    for (const command of DARWIN_PROXY_COMMANDS) {
      settings.set(
        command.kind,
        parseDarwinProxySetting(runCmd("networksetup", [command.get, service])),
      );
    }
    const web = settings.get("web");
    const secureWeb = settings.get("secureWeb");
    const socks = settings.get("socks");
    if (!web || !secureWeb || !socks) {
      throw new Error("Failed to capture all macOS proxy protocols");
    }
    const auto = parseDarwinAutoProxySetting(runCmd("networksetup", ["-getautoproxyurl", service]));
    return { service, web, secureWeb, socks, auto };
  });
  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "darwin",
    services,
  };
}

function assertNoAuthenticatedDarwinProxy(snapshot: DarwinSystemProxySnapshot): void {
  for (const service of snapshot.services) {
    for (const command of DARWIN_PROXY_COMMANDS) {
      if (service[command.kind].authenticated) {
        throw new Error(
          `Cannot safely take over macOS proxy for ${JSON.stringify(service.service)}: ${command.kind} uses an authenticated proxy whose credentials cannot be restored`,
        );
      }
    }
  }
}

function applyDarwinSnapshot(value: unknown): void {
  const snapshot = darwinSnapshot(value);
  assertNoAuthenticatedDarwinProxy(snapshot);

  const activeServices = listDarwinServices();
  const snapshotServices = snapshot.services.map((service) => service.service);
  if (
    activeServices.length !== snapshotServices.length ||
    activeServices.some((service, index) => service !== snapshotServices[index])
  ) {
    throw new Error(
      "macOS network service collection changed; refusing to apply a stale proxy snapshot",
    );
  }

  const failures: string[] = [];
  for (const service of snapshot.services) {
    for (const command of DARWIN_PROXY_COMMANDS) {
      const setting = service[command.kind];
      try {
        runCmd("networksetup", [
          command.set,
          service.service,
          setting.server,
          String(setting.port),
        ]);
      } catch (err) {
        failures.push(
          `${JSON.stringify(service.service)} ${command.kind} server/port: ${errorMessage(err)}`,
        );
      }
    }
    if (service.auto.url) {
      try {
        runCmd("networksetup", ["-setautoproxyurl", service.service, service.auto.url]);
      } catch (err) {
        failures.push(
          `${JSON.stringify(service.service)} automatic proxy URL: ${errorMessage(err)}`,
        );
      }
    }

    const stateOperations = [
      ...DARWIN_PROXY_COMMANDS.map((command) => ({
        label: command.kind,
        command: command.setState,
        enabled: service[command.kind].enabled,
      })),
      {
        label: "automatic proxy",
        command: "-setautoproxystate",
        enabled: service.auto.enabled,
      },
    ];
    // Turn unwanted modes off before enabling the selected modes. This avoids
    // a transition where stale PAC and manual proxy settings are active together.
    for (const operation of [
      ...stateOperations.filter((item) => !item.enabled),
      ...stateOperations.filter((item) => item.enabled),
    ]) {
      try {
        runCmd("networksetup", [
          operation.command,
          service.service,
          operation.enabled ? "on" : "off",
        ]);
      } catch (err) {
        failures.push(
          `${JSON.stringify(service.service)} ${operation.label} state: ${errorMessage(err)}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to apply macOS system proxy settings: ${failures.join("; ")}`);
  }
}

function createDarwinTarget(
  original: SystemProxySnapshot,
  opts: EnableOptions,
): DarwinSystemProxySnapshot {
  const snapshot = darwinSnapshot(original);
  assertNoAuthenticatedDarwinProxy(snapshot);
  if (snapshot.services.length === 0) {
    throw new Error("Cannot enable macOS system proxy: no active network services found");
  }
  const normalized = normalizeEnableOptions(opts);
  const targetSetting = (): DarwinProxySetting => ({
    enabled: true,
    server: normalized.host,
    port: normalized.port,
    authenticated: false,
  });
  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "darwin",
    services: snapshot.services.map((service) => ({
      service: service.service,
      web: targetSetting(),
      secureWeb: targetSetting(),
      socks: targetSetting(),
      auto: { ...service.auto, enabled: false },
    })),
  };
}

function darwinState(value: unknown): SystemProxyState {
  const snapshot = darwinSnapshot(value);
  if (snapshot.services.length === 0) {
    return { supported: true, enabled: false, details: "no active network services found" };
  }

  const enabledSettings: DarwinProxySetting[] = [];
  const enabledAutoUrls: string[] = [];
  for (const service of snapshot.services) {
    for (const command of DARWIN_PROXY_COMMANDS) {
      const setting = service[command.kind];
      if (setting.enabled) enabledSettings.push(setting);
    }
    if (service.auto.enabled) enabledAutoUrls.push(service.auto.url);
  }
  if (enabledSettings.length === 0 && enabledAutoUrls.length === 0) {
    return { supported: true, enabled: false };
  }
  if (enabledSettings.length === 0) {
    const urls = new Set(enabledAutoUrls.filter(Boolean));
    return {
      supported: true,
      enabled: true,
      ...(urls.size === 1 ? { server: urls.values().next().value } : {}),
      details: "automatic proxy configuration is enabled",
    };
  }

  const endpoints = new Set<string>();
  let hasIncompleteEndpoint = false;
  for (const setting of enabledSettings) {
    if (!setting.server || setting.port === 0) {
      hasIncompleteEndpoint = true;
      continue;
    }
    endpoints.add(formatHostPort(setting.server, setting.port));
  }
  if (endpoints.size === 1 && !hasIncompleteEndpoint && enabledAutoUrls.length === 0) {
    const server = endpoints.values().next().value;
    return typeof server === "string"
      ? { supported: true, enabled: true, server }
      : { supported: true, enabled: true };
  }
  return {
    supported: true,
    enabled: true,
    details:
      enabledAutoUrls.length > 0
        ? "manual and automatic proxy settings are both active"
        : "multiple or incomplete active proxy settings",
  };
}

/* ========================================================================== */
/* Linux (GNOME gsettings)                                                    */
/* ========================================================================== */

function ensureGSettingsAvailable(): void {
  if (!isSystemProxySupported("linux")) {
    throw new Error(
      "System proxy cannot be configured automatically: gsettings is not available on this system.",
    );
  }
}

function decodeGSettingsString(content: string): string {
  let decoded = "";
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    const escaped = content[index + 1];
    if (escaped === undefined) throw new Error("Invalid gsettings string: trailing escape");
    index++;
    switch (escaped) {
      case "\\":
        decoded += "\\";
        break;
      case "'":
        decoded += "'";
        break;
      case "n":
        decoded += "\n";
        break;
      case "r":
        decoded += "\r";
        break;
      case "t":
        decoded += "\t";
        break;
      case "b":
        decoded += "\b";
        break;
      case "f":
        decoded += "\f";
        break;
      default:
        throw new Error(`Invalid gsettings string: unsupported escape \\${escaped}`);
    }
  }
  return decoded;
}

/** Parse a single-quoted GVariant string returned by `gsettings get`. */
export function parseGSettingsString(output: string): string {
  const value = output.trim();
  if (value.length < 2 || !value.startsWith("'") || !value.endsWith("'")) {
    throw new Error("Invalid gsettings string: expected a single-quoted value");
  }
  return decodeGSettingsString(value.slice(1, -1));
}

function formatGSettingsString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function parseGSettingsPort(output: string, label: string): number {
  const value = output.trim();
  const match = value.match(/^(?:uint16\s+)?(\d+)$/);
  if (!match?.[1]) {
    throw new Error(`Invalid gsettings ${label}: expected an integer`);
  }
  const port = Number.parseInt(match[1], 10);
  if (port < 0 || port > 65_535) {
    throw new Error(`Invalid gsettings ${label}: expected an integer from 0 to 65535`);
  }
  return port;
}

function parseGSettingsBoolean(output: string, label: string): boolean {
  const value = output.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid gsettings ${label}: expected true or false`);
}

function getLinuxEndpoint(protocol: "http" | "https" | "socks"): LinuxProxyEndpoint {
  const schema = `org.gnome.system.proxy.${protocol}`;
  return {
    host: parseSnapshotString(runGSettingsGet(schema, "host"), `${protocol} host`),
    port: parseGSettingsPort(runCmd("gsettings", ["get", schema, "port"]), `${protocol} port`),
  };
}

function runGSettingsGet(schema: string, key: string): string {
  return parseGSettingsString(runCmd("gsettings", ["get", schema, key]));
}

function captureLinuxSnapshot(): LinuxSystemProxySnapshot {
  ensureGSettingsAvailable();
  const mode = runGSettingsGet("org.gnome.system.proxy", "mode");
  if (mode !== "none" && mode !== "manual" && mode !== "auto") {
    throw new Error("Invalid gsettings mode: expected none, manual, or auto");
  }
  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "linux",
    mode,
    autoConfigUrl: runGSettingsGet("org.gnome.system.proxy", "autoconfig-url"),
    httpUseAuthentication: parseGSettingsBoolean(
      runCmd("gsettings", ["get", "org.gnome.system.proxy.http", "use-authentication"]),
      "HTTP authentication state",
    ),
    http: getLinuxEndpoint("http"),
    https: getLinuxEndpoint("https"),
    socks: getLinuxEndpoint("socks"),
  };
}

function applyLinuxSnapshot(value: unknown): void {
  const snapshot = linuxSnapshot(value);
  ensureGSettingsAvailable();
  const endpoints: ReadonlyArray<{ schema: string; value: LinuxProxyEndpoint }> = [
    { schema: "org.gnome.system.proxy.http", value: snapshot.http },
    { schema: "org.gnome.system.proxy.https", value: snapshot.https },
    { schema: "org.gnome.system.proxy.socks", value: snapshot.socks },
  ];

  // Keep mode last so a partially-written target is not enabled before all endpoints exist.
  runCmd("gsettings", [
    "set",
    "org.gnome.system.proxy",
    "autoconfig-url",
    formatGSettingsString(snapshot.autoConfigUrl),
  ]);
  runCmd("gsettings", [
    "set",
    "org.gnome.system.proxy.http",
    "use-authentication",
    snapshot.httpUseAuthentication ? "true" : "false",
  ]);
  for (const endpoint of endpoints) {
    runCmd("gsettings", [
      "set",
      endpoint.schema,
      "host",
      formatGSettingsString(endpoint.value.host),
    ]);
    runCmd("gsettings", ["set", endpoint.schema, "port", String(endpoint.value.port)]);
  }
  runCmd("gsettings", [
    "set",
    "org.gnome.system.proxy",
    "mode",
    formatGSettingsString(snapshot.mode),
  ]);
}

function createLinuxTarget(
  original: SystemProxySnapshot,
  opts: EnableOptions,
): LinuxSystemProxySnapshot {
  const snapshot = linuxSnapshot(original);
  const normalized = normalizeEnableOptions(opts);
  const endpoint = (): LinuxProxyEndpoint => ({ host: normalized.host, port: normalized.port });
  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "linux",
    mode: "manual",
    autoConfigUrl: snapshot.autoConfigUrl,
    httpUseAuthentication: false,
    http: endpoint(),
    https: endpoint(),
    socks: endpoint(),
  };
}

function linuxState(value: unknown): SystemProxyState {
  const snapshot = linuxSnapshot(value);
  if (snapshot.mode === "auto") {
    return {
      supported: true,
      enabled: true,
      ...(snapshot.autoConfigUrl ? { server: snapshot.autoConfigUrl } : {}),
      details: "automatic proxy configuration is enabled",
    };
  }
  const enabled = snapshot.mode === "manual";
  if (!enabled || !snapshot.http.host || snapshot.http.port === 0) {
    return { supported: true, enabled };
  }
  return {
    supported: true,
    enabled,
    server: formatHostPort(snapshot.http.host, snapshot.http.port),
  };
}

/* ========================================================================== */
/* Backends and compatibility wrappers                                        */
/* ========================================================================== */

class WindowsSystemProxyBackend implements SystemProxyBackend {
  readonly supported = true;

  capture(): SystemProxySnapshot {
    return captureWindowsSnapshot();
  }

  createTarget(original: SystemProxySnapshot, opts: EnableOptions): SystemProxySnapshot {
    return createWindowsTarget(original, opts);
  }

  apply(snapshot: SystemProxySnapshot): void {
    applyWindowsSnapshot(snapshot);
  }

  equivalent(a: SystemProxySnapshot, b: SystemProxySnapshot): boolean {
    return snapshotsEquivalent(a, b);
  }

  compatible(
    current: SystemProxySnapshot,
    original: SystemProxySnapshot,
    target: SystemProxySnapshot,
  ): boolean {
    return snapshotsCompatible(current, original, target);
  }

  state(snapshot: SystemProxySnapshot): SystemProxyState {
    return windowsState(snapshot);
  }
}

class DarwinSystemProxyBackend implements SystemProxyBackend {
  readonly supported = true;

  capture(): SystemProxySnapshot {
    return captureDarwinSnapshot();
  }

  createTarget(original: SystemProxySnapshot, opts: EnableOptions): SystemProxySnapshot {
    return createDarwinTarget(original, opts);
  }

  apply(snapshot: SystemProxySnapshot): void {
    applyDarwinSnapshot(snapshot);
  }

  equivalent(a: SystemProxySnapshot, b: SystemProxySnapshot): boolean {
    return snapshotsEquivalent(a, b);
  }

  compatible(
    current: SystemProxySnapshot,
    original: SystemProxySnapshot,
    target: SystemProxySnapshot,
  ): boolean {
    return snapshotsCompatible(current, original, target);
  }

  state(snapshot: SystemProxySnapshot): SystemProxyState {
    return darwinState(snapshot);
  }
}

class LinuxSystemProxyBackend implements SystemProxyBackend {
  readonly supported = true;

  capture(): SystemProxySnapshot {
    return captureLinuxSnapshot();
  }

  createTarget(original: SystemProxySnapshot, opts: EnableOptions): SystemProxySnapshot {
    return createLinuxTarget(original, opts);
  }

  apply(snapshot: SystemProxySnapshot): void {
    applyLinuxSnapshot(snapshot);
  }

  equivalent(a: SystemProxySnapshot, b: SystemProxySnapshot): boolean {
    return snapshotsEquivalent(a, b);
  }

  compatible(
    current: SystemProxySnapshot,
    original: SystemProxySnapshot,
    target: SystemProxySnapshot,
  ): boolean {
    return snapshotsCompatible(current, original, target);
  }

  state(snapshot: SystemProxySnapshot): SystemProxyState {
    return linuxState(snapshot);
  }
}

class UnsupportedSystemProxyBackend implements SystemProxyBackend {
  readonly supported = false;

  constructor(readonly details: string) {}

  capture(): SystemProxySnapshot {
    throw new Error(this.details);
  }

  createTarget(_original: SystemProxySnapshot, _opts: EnableOptions): SystemProxySnapshot {
    throw new Error(this.details);
  }

  apply(_snapshot: SystemProxySnapshot): void {
    throw new Error(this.details);
  }

  equivalent(a: SystemProxySnapshot, b: SystemProxySnapshot): boolean {
    return snapshotsEquivalent(a, b);
  }

  compatible(
    _current: SystemProxySnapshot,
    _original: SystemProxySnapshot,
    _target: SystemProxySnapshot,
  ): boolean {
    return false;
  }

  state(snapshot: SystemProxySnapshot): SystemProxyState {
    parseSystemProxySnapshot(snapshot);
    return { supported: false, enabled: false, details: this.details };
  }
}

/** Create a backend for the current platform (or a supplied platform in tests). */
export function createSystemProxyBackend(
  platform: NodeJS.Platform = process.platform,
): SystemProxyBackend {
  switch (platform) {
    case "win32":
      return new WindowsSystemProxyBackend();
    case "darwin":
      return new DarwinSystemProxyBackend();
    case "linux":
      return isSystemProxySupported("linux")
        ? new LinuxSystemProxyBackend()
        : new UnsupportedSystemProxyBackend(
            "gsettings not available; desktop proxy configuration unsupported",
          );
    default:
      return new UnsupportedSystemProxyBackend(`unsupported platform: ${platform}`);
  }
}

/**
 * Build the narrow cleanup used when migrating a pre-journal daemon. It only
 * disables manual proxy fields that still point exactly at Sash's loopback
 * target and never changes a third-party endpoint or automatic proxy value.
 */
export function createLegacyProxyCleanup(
  value: unknown,
  opts: EnableOptions,
): SystemProxySnapshot | undefined {
  const snapshot = parseSystemProxySnapshot(value);
  const normalized = normalizeEnableOptions(opts);
  const target = formatHostPort(normalized.host, normalized.port);

  switch (snapshot.platform) {
    case "win32":
      return snapshot.proxyEnable === 1 && snapshot.proxyServer === target
        ? { ...snapshot, proxyEnable: 0 }
        : undefined;
    case "darwin": {
      let matched = false;
      let conflict = false;
      const clean = (setting: DarwinProxySetting): DarwinProxySetting => {
        if (!setting.enabled) return setting;
        if (formatHostPort(setting.server, setting.port) !== target) {
          conflict = true;
          return setting;
        }
        matched = true;
        return { ...setting, enabled: false };
      };
      const services = snapshot.services.map((service) => ({
        ...service,
        web: clean(service.web),
        secureWeb: clean(service.secureWeb),
        socks: clean(service.socks),
      }));
      if (!matched || conflict) return undefined;
      return { ...snapshot, services };
    }
    case "linux":
      if (
        snapshot.mode !== "manual" ||
        [snapshot.http, snapshot.https, snapshot.socks].some(
          (endpoint) => formatHostPort(endpoint.host, endpoint.port) !== target,
        )
      ) {
        return undefined;
      }
      return { ...snapshot, mode: "none" };
  }
}

export async function disableLegacySystemProxyIfOwned(opts: EnableOptions): Promise<boolean> {
  const backend = createSystemProxyBackend();
  if (backend.supported === false) return false;
  const current = backend.capture();
  const cleanup = createLegacyProxyCleanup(current, opts);
  if (!cleanup) return false;
  backend.apply(cleanup);
  const verified = backend.capture();
  if (!backend.equivalent(verified, cleanup)) {
    throw new Error("Legacy system proxy cleanup could not be verified");
  }
  return true;
}
