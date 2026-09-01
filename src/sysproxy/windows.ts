import { execFileSync } from "node:child_process";
import { formatHostPort, normalizeEnableOptions, parseProxyString, runCmd } from "./common.js";
import { windowsSnapshot } from "./snapshot.js";
import type {
  EnableOptions,
  SystemProxySnapshot,
  SystemProxyState,
  WindowsRegistryProxyValues,
  WindowsSystemProxySnapshot,
} from "./types.js";
import { DEFAULT_BYPASS_LIST, SYSTEM_PROXY_SNAPSHOT_VERSION } from "./types.js";

const WIN_REG_PATH = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const REGISTRY_HEADERS = new Set(
  [WIN_REG_PATH, WIN_REG_PATH.replace(/^HKCU/, "HKEY_CURRENT_USER")].map((header) =>
    header.toLowerCase(),
  ),
);
const MANAGED_VALUE_LINE =
  /^[^\S\r\n]*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL|AutoDetect)[^\S\r\n]+(REG_[A-Z0-9_]+)(?:[^\S\r\n]+(.*))?[^\S\r\n]*$/i;
const MANAGED_VALUE_PREFIX =
  /^[^\S\r\n]*(?:ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL|AutoDetect)(?:[^\S\r\n]|$)/i;
const GENERIC_REGISTRY_VALUE_LINE =
  /^[^\S\r\n]*.+?[^\S\r\n]+REG_[A-Z0-9_]+(?:[^\S\r\n]+.*)?[^\S\r\n]*$/i;

type WindowsValueName =
  | "ProxyEnable"
  | "ProxyServer"
  | "ProxyOverride"
  | "AutoConfigURL"
  | "AutoDetect";

export function formatWindowsBypass(list: string[] = DEFAULT_BYPASS_LIST): string {
  return list.join(";");
}

function emptyWindowsRegistryProxyValues(): WindowsRegistryProxyValues {
  return {
    proxyEnable: null,
    proxyServer: null,
    proxyOverride: null,
    autoConfigUrl: null,
    autoDetect: null,
  };
}

function setWindowsRegistryProxyValue(
  values: WindowsRegistryProxyValues,
  seen: Set<string>,
  name: string,
  type: string,
  rawValue: string,
): void {
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
    if (name === "proxyenable") values.proxyEnable = value;
    else values.autoDetect = value;
    return;
  }

  if (type !== "REG_SZ") {
    throw new Error(`Invalid Windows registry output: ${name} must be REG_SZ`);
  }
  const value = parseProxyString(rawValue.replace(/\r$/, ""), name);
  if (name === "proxyserver") {
    values.proxyServer = value;
  } else if (name === "proxyoverride") {
    values.proxyOverride = value;
  } else {
    values.autoConfigUrl = value;
  }
}

function parseManagedWindowsRegistryValue(
  line: string,
  values: WindowsRegistryProxyValues,
  seen: Set<string>,
): boolean {
  const match = line.match(MANAGED_VALUE_LINE);
  if (!match) return false;

  const name = match[1]?.toLowerCase();
  const type = match[2]?.toUpperCase();
  if (!name || !type) {
    throw new Error("Invalid Windows registry output: malformed managed value");
  }
  setWindowsRegistryProxyValue(values, seen, name, type, match[3] ?? "");
  return true;
}

/**
 * Strictly parse managed values from the exact `reg query` response used for
 * ownership snapshots. A header and at least one managed value are required so
 * empty, unrelated, or truncated command output cannot become an all-null snapshot.
 */
export function parseWindowsRegistryProxyValues(output: string): WindowsRegistryProxyValues {
  const lines = output.split(/\r\n?|\n/);
  let headerIndex = 0;
  while (headerIndex < lines.length && (lines[headerIndex] ?? "").trim().length === 0) {
    headerIndex++;
  }
  if (!REGISTRY_HEADERS.has((lines[headerIndex] ?? "").trim().toLowerCase())) {
    throw new Error("Invalid Windows registry output: missing Internet Settings registry header");
  }

  const values = emptyWindowsRegistryProxyValues();
  const seen = new Set<string>();
  for (let index = headerIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    if (parseManagedWindowsRegistryValue(line, values, seen)) continue;
    if (MANAGED_VALUE_PREFIX.test(line)) {
      throw new Error("Invalid Windows registry output: malformed managed value");
    }
    if (!GENERIC_REGISTRY_VALUE_LINE.test(line)) {
      throw new Error("Invalid Windows registry output: unexpected line in registry response");
    }
  }
  if (seen.size === 0) {
    throw new Error("Invalid Windows registry output: missing managed proxy values");
  }
  return values;
}

function parseLegacyWindowsRegistryProxyValues(output: string): WindowsRegistryProxyValues {
  const values = emptyWindowsRegistryProxyValues();
  const seen = new Set<string>();
  for (const line of output.split(/\n/)) {
    parseManagedWindowsRegistryValue(line, values, seen);
  }
  return values;
}

/**
 * Legacy display parser retained for existing callers. It intentionally accepts
 * incomplete and headerless output; ownership capture uses the strict parser above.
 */
export function parseWindowsRegQuery(output: string): { enabled: boolean; server?: string } {
  try {
    const values = parseLegacyWindowsRegistryProxyValues(output);
    const enabled = values.proxyEnable === 1;
    return values.proxyServer === null || values.proxyServer.length === 0
      ? { enabled }
      : { enabled, server: values.proxyServer };
  } catch {
    return { enabled: false };
  }
}

export function captureWindowsSnapshot(): WindowsSystemProxySnapshot {
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

export function applyWindowsSnapshot(value: unknown): void {
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

export function createWindowsTarget(
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

export function windowsState(value: unknown): SystemProxyState {
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
