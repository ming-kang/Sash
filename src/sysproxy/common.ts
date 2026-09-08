import { errorMessage } from "../error-utils.js";
import { isPlainObject } from "../json-shape.js";
import { runSanitizedCommandAsync, windowsSystemExecutable } from "../process.js";
import type { EnableOptions } from "./types.js";
import { DEFAULT_BYPASS_LIST } from "./types.js";

const MAX_PROXY_STRING_LENGTH = 4096;

export { errorMessage, isPlainObject };

export function parseProxyString(value: unknown, label: string, allowEmpty = true): string {
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

export function parseProxyEnable(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(
      "Invalid system proxy snapshot: proxyEnable must be null or an unsigned 32-bit integer",
    );
  }
  return value;
}

export function runCmd(cmd: string, args: string[], timeoutMs = 5000): Promise<string> {
  return runSanitizedCommandAsync(
    cmd.toLowerCase() === "reg.exe" ? windowsSystemExecutable("reg.exe") : cmd,
    args,
    { timeoutMs },
  );
}

export function normalizeEnableOptions(opts: EnableOptions): {
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
  const host = opts.host === undefined ? "127.0.0.1" : parseProxyString(opts.host, "host", false);
  const rawBypass = opts.bypass ?? DEFAULT_BYPASS_LIST;
  if (!Array.isArray(rawBypass)) {
    throw new Error("System proxy bypass list must be an array of strings");
  }
  const bypass = rawBypass.map((entry, index) =>
    parseProxyString(entry, `bypass[${index}]`, false),
  );
  if (bypass.join(";").length > MAX_PROXY_STRING_LENGTH) {
    throw new Error("System proxy bypass list is too long");
  }
  return { host, port: opts.port, bypass };
}

export function formatHostPort(host: string, port: number): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
}

export function isSystemProxySupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}
