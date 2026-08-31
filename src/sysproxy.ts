import { execFileSync } from "node:child_process";

/**
 * OS-level system proxy management.
 *
 * - Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
 *   via reg.exe + WinINet InternetSetOption notification via PowerShell.
 *   Per-user; requires no elevation.
 * - macOS: networksetup against all active network services.
 * - Linux: GNOME gsettings (mode manual/none).
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

export function isSystemProxySupported(platform = process.platform): boolean {
  if (platform === "win32" || platform === "darwin") return true;
  if (platform === "linux") {
    try {
      execFileSync("which", ["gsettings"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function runCmd(cmd: string, args: string[], timeoutMs = 5000): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/* ========================================================================== */
/* Windows                                                                    */
/* ========================================================================== */

const WIN_REG_PATH = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

export function formatWindowsBypass(list: string[] = DEFAULT_BYPASS_LIST): string {
  return list.join(";");
}

export function parseWindowsRegQuery(output: string): { enabled: boolean; server?: string } {
  const enableMatch = output.match(/ProxyEnable\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/i);
  const serverMatch = output.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);

  let enabled = false;
  if (enableMatch?.[1]) {
    const val = Number.parseInt(enableMatch[1], enableMatch[1].startsWith("0x") ? 16 : 10);
    enabled = val === 1;
  }
  const server = serverMatch?.[1];
  return { enabled, server };
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
    "  [Interop.WinINet]::InternetSetOption([IntPtr]::Zero, 41, [IntPtr]::Zero, 0) | Out-Null",
    "}",
  ].join("\n");
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 5000,
      stdio: "ignore",
    });
  } catch {
    // Best effort; registry write already took effect
  }
}

function enableWindowsProxy(opts: EnableOptions): void {
  const host = opts.host ?? "127.0.0.1";
  const target = `${host}:${opts.port}`;
  const bypass = formatWindowsBypass(opts.bypass);

  runCmd("reg.exe", ["add", WIN_REG_PATH, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"]);
  runCmd("reg.exe", ["add", WIN_REG_PATH, "/v", "ProxyServer", "/t", "REG_SZ", "/d", target, "/f"]);
  runCmd("reg.exe", [
    "add",
    WIN_REG_PATH,
    "/v",
    "ProxyOverride",
    "/t",
    "REG_SZ",
    "/d",
    bypass,
    "/f",
  ]);
  refreshWindowsWinINet();
}

function disableWindowsProxy(): void {
  runCmd("reg.exe", ["add", WIN_REG_PATH, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"]);
  refreshWindowsWinINet();
}

function getWindowsProxyState(): SystemProxyState {
  try {
    const out = runCmd("reg.exe", ["query", WIN_REG_PATH]);
    const { enabled, server } = parseWindowsRegQuery(out);
    return {
      supported: true,
      enabled,
      server: enabled ? server : undefined,
    };
  } catch (err) {
    return {
      supported: true,
      enabled: false,
      details: (err as Error).message,
    };
  }
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

export function parseDarwinGetWebProxy(output: string): { enabled: boolean; server?: string } {
  const enabledMatch = output.match(/Enabled:\s*(Yes|No)/i);
  const serverMatch = output.match(/^Server:\s*([^\r\n\s]+)/im);
  const portMatch = output.match(/^Port:\s*(\d+)/im);

  const enabled = enabledMatch?.[1]?.toLowerCase() === "yes";
  const port = portMatch?.[1] && portMatch[1] !== "0" ? portMatch[1] : undefined;
  const host = serverMatch?.[1];
  const server = enabled && host && port ? `${host}:${port}` : undefined;
  return { enabled, server };
}

function listDarwinServices(): string[] {
  const out = runCmd("networksetup", ["-listallnetworkservices"]);
  return parseDarwinServices(out);
}

function enableDarwinProxy(opts: EnableOptions): void {
  const host = opts.host ?? "127.0.0.1";
  const portStr = String(opts.port);
  const services = listDarwinServices();

  for (const svc of services) {
    try {
      runCmd("networksetup", ["-setwebproxy", svc, host, portStr]);
      runCmd("networksetup", ["-setsecurewebproxy", svc, host, portStr]);
      runCmd("networksetup", ["-setsocksfirewallproxy", svc, host, portStr]);
      runCmd("networksetup", ["-setwebproxystate", svc, "on"]);
      runCmd("networksetup", ["-setsecurewebproxystate", svc, "on"]);
      runCmd("networksetup", ["-setsocksfirewallproxystate", svc, "on"]);
    } catch {
      // Some services may not be configurable without elevation; continue
    }
  }
}

function disableDarwinProxy(): void {
  const services = listDarwinServices();
  for (const svc of services) {
    try {
      runCmd("networksetup", ["-setwebproxystate", svc, "off"]);
      runCmd("networksetup", ["-setsecurewebproxystate", svc, "off"]);
      runCmd("networksetup", ["-setsocksfirewallproxystate", svc, "off"]);
    } catch {
      // ignore
    }
  }
}

function getDarwinProxyState(): SystemProxyState {
  try {
    const services = listDarwinServices();
    const first = services[0];
    if (!first) {
      return { supported: true, enabled: false, details: "no network services found" };
    }
    const out = runCmd("networksetup", ["-getwebproxy", first]);
    const { enabled, server } = parseDarwinGetWebProxy(out);
    return {
      supported: true,
      enabled,
      server: enabled ? server : undefined,
    };
  } catch (err) {
    return { supported: true, enabled: false, details: (err as Error).message };
  }
}

/* ========================================================================== */
/* Linux (GNOME)                                                              */
/* ========================================================================== */

function enableLinuxProxy(opts: EnableOptions): void {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port;

  runCmd("gsettings", ["set", "org.gnome.system.proxy", "mode", "manual"]);
  runCmd("gsettings", ["set", "org.gnome.system.proxy.http", "host", host]);
  runCmd("gsettings", ["set", "org.gnome.system.proxy.http", "port", String(port)]);
  runCmd("gsettings", ["set", "org.gnome.system.proxy.https", "host", host]);
  runCmd("gsettings", ["set", "org.gnome.system.proxy.https", "port", String(port)]);
  runCmd("gsettings", ["set", "org.gnome.system.proxy.socks", "host", host]);
  runCmd("gsettings", ["set", "org.gnome.system.proxy.socks", "port", String(port)]);
}

function disableLinuxProxy(): void {
  runCmd("gsettings", ["set", "org.gnome.system.proxy", "mode", "none"]);
}

function getLinuxProxyState(): SystemProxyState {
  if (!isSystemProxySupported("linux")) {
    return {
      supported: false,
      enabled: false,
      details: "gsettings not available; desktop proxy configuration unsupported",
    };
  }
  try {
    const mode = runCmd("gsettings", ["get", "org.gnome.system.proxy", "mode"]).replace(/'/g, "");
    const enabled = mode === "manual";
    let server: string | undefined;
    if (enabled) {
      const host = runCmd("gsettings", ["get", "org.gnome.system.proxy.http", "host"]).replace(
        /'/g,
        "",
      );
      const port = runCmd("gsettings", ["get", "org.gnome.system.proxy.http", "port"]);
      if (host && port) server = `${host}:${port}`;
    }
    return { supported: true, enabled, server };
  } catch (err) {
    return { supported: true, enabled: false, details: (err as Error).message };
  }
}

/* ========================================================================== */
/* Public API                                                                 */
/* ========================================================================== */

export async function enableSystemProxy(opts: EnableOptions): Promise<void> {
  const platform = process.platform;
  if (platform === "win32") return enableWindowsProxy(opts);
  if (platform === "darwin") return enableDarwinProxy(opts);
  if (platform === "linux") {
    if (!isSystemProxySupported("linux")) {
      throw new Error(
        "System proxy cannot be configured automatically: gsettings is not available on this system.",
      );
    }
    return enableLinuxProxy(opts);
  }
  throw new Error(`System proxy is not supported on platform: ${platform}`);
}

export async function disableSystemProxy(): Promise<void> {
  const platform = process.platform;
  if (platform === "win32") return disableWindowsProxy();
  if (platform === "darwin") return disableDarwinProxy();
  if (platform === "linux") {
    if (!isSystemProxySupported("linux")) return;
    return disableLinuxProxy();
  }
}

export function getSystemProxyState(): SystemProxyState {
  const platform = process.platform;
  if (platform === "win32") return getWindowsProxyState();
  if (platform === "darwin") return getDarwinProxyState();
  if (platform === "linux") return getLinuxProxyState();
  return {
    supported: false,
    enabled: false,
    details: `unsupported platform: ${platform}`,
  };
}
