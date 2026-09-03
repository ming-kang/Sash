import {
  formatHostPort,
  isSystemProxySupported,
  normalizeEnableOptions,
  parseProxyString,
  runCmd,
} from "./common.js";
import { linuxSnapshot } from "./snapshot.js";
import type {
  EnableOptions,
  LinuxProxyEndpoint,
  LinuxSystemProxySnapshot,
  SystemProxySnapshot,
  SystemProxyState,
} from "./types.js";
import { SYSTEM_PROXY_SNAPSHOT_VERSION } from "./types.js";

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

type CommandRunner = typeof runCmd;

async function getLinuxEndpoint(
  protocol: "http" | "https" | "socks",
  run: CommandRunner,
): Promise<LinuxProxyEndpoint> {
  const schema = `org.gnome.system.proxy.${protocol}`;
  return {
    host: parseProxyString(await runGSettingsGet(schema, "host", run), `${protocol} host`),
    port: parseGSettingsPort(await run("gsettings", ["get", schema, "port"]), `${protocol} port`),
  };
}

async function runGSettingsGet(schema: string, key: string, run: CommandRunner): Promise<string> {
  return parseGSettingsString(await run("gsettings", ["get", schema, key]));
}

export async function captureLinuxSnapshot(
  run: CommandRunner = runCmd,
  ensureAvailable: () => void = ensureGSettingsAvailable,
): Promise<LinuxSystemProxySnapshot> {
  ensureAvailable();
  const mode = await runGSettingsGet("org.gnome.system.proxy", "mode", run);
  if (mode !== "none" && mode !== "manual" && mode !== "auto") {
    throw new Error("Invalid gsettings mode: expected none, manual, or auto");
  }
  const autoConfigUrl = await runGSettingsGet("org.gnome.system.proxy", "autoconfig-url", run);
  const httpUseAuthentication = parseGSettingsBoolean(
    await run("gsettings", ["get", "org.gnome.system.proxy.http", "use-authentication"]),
    "HTTP authentication state",
  );
  const http = await getLinuxEndpoint("http", run);
  const https = await getLinuxEndpoint("https", run);
  const socks = await getLinuxEndpoint("socks", run);
  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "linux",
    mode,
    autoConfigUrl,
    httpUseAuthentication,
    http,
    https,
    socks,
  };
}

export async function applyLinuxSnapshot(
  value: unknown,
  run: CommandRunner = runCmd,
  ensureAvailable: () => void = ensureGSettingsAvailable,
): Promise<void> {
  const snapshot = linuxSnapshot(value);
  ensureAvailable();
  const endpoints: ReadonlyArray<{ schema: string; value: LinuxProxyEndpoint }> = [
    { schema: "org.gnome.system.proxy.http", value: snapshot.http },
    { schema: "org.gnome.system.proxy.https", value: snapshot.https },
    { schema: "org.gnome.system.proxy.socks", value: snapshot.socks },
  ];

  // Keep mode last so a partially-written target is not enabled before all endpoints exist.
  await run("gsettings", [
    "set",
    "org.gnome.system.proxy",
    "autoconfig-url",
    formatGSettingsString(snapshot.autoConfigUrl),
  ]);
  await run("gsettings", [
    "set",
    "org.gnome.system.proxy.http",
    "use-authentication",
    snapshot.httpUseAuthentication ? "true" : "false",
  ]);
  for (const endpoint of endpoints) {
    await run("gsettings", [
      "set",
      endpoint.schema,
      "host",
      formatGSettingsString(endpoint.value.host),
    ]);
    await run("gsettings", ["set", endpoint.schema, "port", String(endpoint.value.port)]);
  }
  await run("gsettings", [
    "set",
    "org.gnome.system.proxy",
    "mode",
    formatGSettingsString(snapshot.mode),
  ]);
}

export function createLinuxTarget(
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

export function linuxState(value: unknown): SystemProxyState {
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
