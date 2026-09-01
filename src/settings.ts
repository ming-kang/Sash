import crypto from "node:crypto";
import fs from "node:fs";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { acquireStateLockSync } from "./state-lock.js";

/** Sash's own settings, persisted to <root>/sash.json. */
export interface SashSettings {
  /** Version of the on-disk sash.json schema. */
  schemaVersion: 1;
  /** Legacy single-subscription field; removed after one-time profile migration. */
  subscriptionUrl?: string;
  mixedPort: number;
  /** external-controller listen address, e.g. 127.0.0.1:9090 */
  controller: string;
  /** API secret for the external-controller. */
  secret: string;
  /** Enable TUN inbound in the generated config (requires admin/root). */
  tun: boolean;
  /** allow-lan toggle for the generated config. */
  allowLan: boolean;
  /** sashd control API listen port on 127.0.0.1. */
  daemonPort: number;
  /** Bearer token authenticating the CLI (and future WebUI) against sashd. */
  daemonSecret: string;
  /** Desired OS-level system proxy state; sashd applies/reconciles it. */
  systemProxy: boolean;
}

export type PublicSashSettings = Pick<
  SashSettings,
  "mixedPort" | "controller" | "tun" | "allowLan" | "daemonPort" | "systemProxy"
>;

const CANONICAL_SETTINGS_KEYS = [
  "schemaVersion",
  "subscriptionUrl",
  "mixedPort",
  "controller",
  "secret",
  "tun",
  "allowLan",
  "daemonPort",
  "daemonSecret",
  "systemProxy",
] as const;

const LEGACY_SETTINGS_KEYS = ["coreVersion", "uiVersion"] as const;
const ACCEPTED_SETTINGS_KEYS = new Set<string>([
  ...CANONICAL_SETTINGS_KEYS,
  ...LEGACY_SETTINGS_KEYS,
]);

export function publicSettings(settings: SashSettings): PublicSashSettings {
  return {
    mixedPort: settings.mixedPort,
    controller: settings.controller,
    tun: settings.tun,
    allowLan: settings.allowLan,
    daemonPort: settings.daemonPort,
    systemProxy: settings.systemProxy,
  };
}

export const DEFAULT_SETTINGS: SashSettings = {
  schemaVersion: 1,
  mixedPort: 17890,
  controller: "127.0.0.1:9090",
  secret: "",
  tun: false,
  allowLan: false,
  daemonPort: 19090,
  daemonSecret: "",
  systemProxy: false,
};

interface ParsedSettings {
  settings: SashSettings;
  needsRewrite: boolean;
}

interface FieldResult<T> {
  value: T;
  missing: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(object, key);
}

function invalidSettings(file: string, message: string): Error {
  return new Error(`Settings are invalid: ${file}: ${message}`);
}

function readRequiredField<T>(
  source: Record<string, unknown>,
  key: string,
  defaultValue: T,
  allowMissing: boolean,
  file: string,
  parse: (value: unknown, key: string, file: string) => T,
): FieldResult<T> {
  if (!hasOwn(source, key)) {
    if (!allowMissing) throw invalidSettings(file, `${key} is required`);
    return { value: defaultValue, missing: true };
  }

  const value = source[key];
  if (value === null) throw invalidSettings(file, `${key} must not be null`);
  return { value: parse(value, key, file), missing: false };
}

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  file: string,
): string | undefined {
  if (!hasOwn(source, key)) return undefined;
  const value = source[key];
  if (value === null) throw invalidSettings(file, `${key} must not be null`);
  return parseString(value, key, file);
}

function parseString(value: unknown, key: string, file: string): string {
  if (typeof value !== "string") throw invalidSettings(file, `${key} must be a string`);
  return value;
}

function parseBoolean(value: unknown, key: string, file: string): boolean {
  if (typeof value !== "boolean") throw invalidSettings(file, `${key} must be a boolean`);
  return value;
}

function parsePort(value: unknown, key: string, file: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw invalidSettings(file, `${key} must be an integer from 1 to 65535`);
  }
  return value;
}

function parseController(value: unknown, key: string, file: string): string {
  const controller = parseString(value, key, file);
  const address = parseControllerAddress(controller);
  if (!address) {
    throw invalidSettings(file, `${key} must be a loopback host:port controller address`);
  }
  return address.canonical;
}

function parseSchemaVersion(
  source: Record<string, unknown>,
  allowMissing: boolean,
  file: string,
): FieldResult<0 | 1> {
  if (!hasOwn(source, "schemaVersion")) {
    if (!allowMissing) throw invalidSettings(file, "schemaVersion is required");
    return { value: 0, missing: true };
  }

  const value = source.schemaVersion;
  if (value === null) throw invalidSettings(file, "schemaVersion must not be null");
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidSettings(file, "schemaVersion must be an integer");
  }
  if (value === 0 || value === 1) return { value, missing: false };
  if (value > 1) {
    throw invalidSettings(file, `schemaVersion ${value} is from a future version`);
  }
  throw invalidSettings(file, "schemaVersion must be 0 or 1");
}

function parseSettings(document: unknown, file: string, allowMissing: boolean): ParsedSettings {
  if (!isPlainObject(document)) {
    throw invalidSettings(file, "JSON root must be a plain object");
  }

  for (const key of Object.keys(document)) {
    if (!ACCEPTED_SETTINGS_KEYS.has(key)) {
      throw invalidSettings(file, `unknown field ${JSON.stringify(key)}`);
    }
  }

  const schemaVersion = parseSchemaVersion(document, allowMissing, file);
  const subscriptionUrl = readOptionalString(document, "subscriptionUrl", file);
  const mixedPort = readRequiredField(
    document,
    "mixedPort",
    DEFAULT_SETTINGS.mixedPort,
    allowMissing,
    file,
    parsePort,
  );
  const controller = readRequiredField(
    document,
    "controller",
    DEFAULT_SETTINGS.controller,
    allowMissing,
    file,
    parseController,
  );
  const secret = readRequiredField(
    document,
    "secret",
    DEFAULT_SETTINGS.secret,
    allowMissing,
    file,
    parseString,
  );
  const tun = readRequiredField(
    document,
    "tun",
    DEFAULT_SETTINGS.tun,
    allowMissing,
    file,
    parseBoolean,
  );
  const allowLan = readRequiredField(
    document,
    "allowLan",
    DEFAULT_SETTINGS.allowLan,
    allowMissing,
    file,
    parseBoolean,
  );
  const daemonPort = readRequiredField(
    document,
    "daemonPort",
    DEFAULT_SETTINGS.daemonPort,
    allowMissing,
    file,
    parsePort,
  );
  const daemonSecret = readRequiredField(
    document,
    "daemonSecret",
    DEFAULT_SETTINGS.daemonSecret,
    allowMissing,
    file,
    parseString,
  );
  const systemProxy = readRequiredField(
    document,
    "systemProxy",
    DEFAULT_SETTINGS.systemProxy,
    allowMissing,
    file,
    parseBoolean,
  );

  let needsRewrite =
    schemaVersion.missing ||
    schemaVersion.value === 0 ||
    mixedPort.missing ||
    controller.missing ||
    controller.value !== document.controller ||
    secret.missing ||
    tun.missing ||
    allowLan.missing ||
    daemonPort.missing ||
    daemonSecret.missing ||
    systemProxy.missing;

  for (const key of LEGACY_SETTINGS_KEYS) {
    if (!hasOwn(document, key)) continue;
    const value = document[key];
    if (value === null) throw invalidSettings(file, `${key} must not be null`);
    parseString(value, key, file);
    needsRewrite = true;
  }

  let normalizedSecret = secret.value;
  if (!normalizedSecret) {
    normalizedSecret = generateSecret();
    needsRewrite = true;
  }

  let normalizedDaemonSecret = daemonSecret.value;
  if (!normalizedDaemonSecret) {
    normalizedDaemonSecret = generateSecret();
    needsRewrite = true;
  }

  const settings: SashSettings = {
    schemaVersion: 1,
    mixedPort: mixedPort.value,
    controller: controller.value,
    secret: normalizedSecret,
    tun: tun.value,
    allowLan: allowLan.value,
    daemonPort: daemonPort.value,
    daemonSecret: normalizedDaemonSecret,
    systemProxy: systemProxy.value,
  };
  if (subscriptionUrl !== undefined) settings.subscriptionUrl = subscriptionUrl;

  return { settings, needsRewrite };
}

function readSettingsFile(file: string): { exists: boolean; document: unknown } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, document: {} };
    }
    throw err;
  }

  try {
    return { exists: true, document: JSON.parse(text) as unknown };
  } catch (err) {
    throw new Error(
      `Settings file is invalid JSON: ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function canonicalSettings(settings: SashSettings): SashSettings {
  const canonical: SashSettings = {
    schemaVersion: 1,
    mixedPort: settings.mixedPort,
    controller: settings.controller,
    secret: settings.secret,
    tun: settings.tun,
    allowLan: settings.allowLan,
    daemonPort: settings.daemonPort,
    daemonSecret: settings.daemonSecret,
    systemProxy: settings.systemProxy,
  };
  if (settings.subscriptionUrl !== undefined) canonical.subscriptionUrl = settings.subscriptionUrl;
  return canonical;
}

function writeCanonicalSettings(settings: SashSettings, layout: SashLayout): void {
  atomicWriteFileSync(
    layout.settingsFile,
    `${JSON.stringify(canonicalSettings(settings), null, 2)}\n`,
  );
}

function loadSettingsUnlocked(layout: SashLayout): SashSettings {
  const source = readSettingsFile(layout.settingsFile);
  const parsed = parseSettings(source.document, layout.settingsFile, true);
  if (!source.exists || parsed.needsRewrite) {
    writeCanonicalSettings(parsed.settings, layout);
  }
  return parsed.settings;
}

export function generateSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function loadSettings(layout: SashLayout = sashLayout()): SashSettings {
  const lease = acquireStateLockSync(layout.settingsLockFile, { purpose: "settings" });
  try {
    return loadSettingsUnlocked(layout);
  } finally {
    lease.release();
  }
}

export function saveSettings(settings: SashSettings, layout: SashLayout = sashLayout()): void {
  const lease = acquireStateLockSync(layout.settingsLockFile, { purpose: "settings" });
  try {
    const parsed = parseSettings(settings, layout.settingsFile, false);
    writeCanonicalSettings(parsed.settings, layout);
  } finally {
    lease.release();
  }
}

/** Keys accepted by `sash config set` and the sashd PATCH /settings route. */
export const SETTABLE_KEYS = [
  "tun",
  "allow-lan",
  "mixed-port",
  "controller",
  "secret",
  "system-proxy",
] as const;

export type SettableKey = (typeof SETTABLE_KEYS)[number];

/**
 * These keys change where/how the core listens or authenticates; a running
 * core cannot apply them via PUT /configs (it would still be on the old
 * address/secret), so they require a restart.
 */
export function requiresCoreRestart(key: string): boolean {
  switch (key) {
    case "controller":
    case "secret":
    case "tun":
    case "mixed-port":
    case "allow-lan":
      return true;
    default:
      return false;
  }
}

export interface ControllerAddress {
  host: "127.0.0.1" | "localhost" | "::1";
  port: number;
  canonical: string;
}

/** Parse the internal controller boundary. Sash never sends its bearer off-loopback. */
export function parseControllerAddress(value: string): ControllerAddress | undefined {
  const match = value.trim().match(/^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/i);
  const rawHost = match?.[1]?.toLowerCase();
  const rawPort = match?.[2];
  if (!rawHost || !rawPort) return undefined;
  const port = Number.parseInt(rawPort, 10);
  if (port < 1 || port > 65_535 || String(port) !== rawPort) return undefined;

  if (rawHost === "[::1]") {
    return { host: "::1", port, canonical: `[::1]:${port}` };
  }
  const host = rawHost === "localhost" ? "localhost" : "127.0.0.1";
  return { host, port, canonical: `${host}:${port}` };
}

export function validateController(value: string): boolean {
  return parseControllerAddress(value) !== undefined;
}

function parseOnOff(value: string | undefined): boolean {
  if (value === "on" || value === "true" || value === "1") return true;
  if (value === "off" || value === "false" || value === "0") return false;
  throw new Error(`expected on|off, got: ${value ?? ""}`);
}

/**
 * Validate and apply one managed key to `settings`, mutating it in place.
 * Shared by the CLI (`config set`) and the sashd settings route so both
 * accept exactly the same inputs.
 */
export function applyManagedKey(
  settings: SashSettings,
  key: string,
  value: string | undefined,
): void {
  switch (key) {
    case "tun":
      settings.tun = parseOnOff(value);
      break;
    case "allow-lan":
      settings.allowLan = parseOnOff(value);
      break;
    case "system-proxy":
      settings.systemProxy = parseOnOff(value);
      break;
    case "mixed-port": {
      const raw = (value ?? "").trim();
      const port = Number.parseInt(raw, 10);
      if (!raw || !Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== raw) {
        throw new Error(`invalid port: ${value ?? ""} (expected 1-65535)`);
      }
      settings.mixedPort = port;
      break;
    }
    case "controller": {
      const v = (value ?? "").trim();
      const address = parseControllerAddress(v);
      if (!address) {
        throw new Error(`invalid controller address: ${v} (expected loopback host:port)`);
      }
      settings.controller = address.canonical;
      break;
    }
    case "secret":
      settings.secret = !value || value === "regenerate" ? generateSecret() : value.trim();
      break;
    default:
      throw new Error(`unknown key: ${key} (settable: ${SETTABLE_KEYS.join(", ")})`);
  }
}
