import crypto from "node:crypto";
import fs from "node:fs";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { isPlainObject } from "./json-shape.js";
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

const PUBLIC_SETTINGS_KEYS = [
  "mixedPort",
  "controller",
  "tun",
  "allowLan",
  "daemonPort",
  "systemProxy",
] as const satisfies readonly (keyof SashSettings)[];

export type PublicSashSettings = Pick<SashSettings, (typeof PUBLIC_SETTINGS_KEYS)[number]>;

type ExhaustiveKeyList<T, Keys extends readonly (keyof T)[]> = Keys &
  (Exclude<keyof T, Keys[number]> extends never
    ? unknown
    : { readonly missingKeys: Exclude<keyof T, Keys[number]> });

function exhaustiveKeys<T>() {
  return <const Keys extends readonly (keyof T)[]>(keys: ExhaustiveKeyList<T, Keys>): Keys => keys;
}

const CANONICAL_SETTINGS_KEYS = exhaustiveKeys<SashSettings>()([
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
]);

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

export function sameSettings(a: SashSettings, b: SashSettings): boolean {
  return CANONICAL_SETTINGS_KEYS.every((key) => a[key] === b[key]);
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

function hasSecretControlCharacter(secret: string): boolean {
  for (const char of secret) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function parseSecret(value: unknown, key: string, file: string): string {
  const secret = parseString(value, key, file);
  if (!secret.trim()) throw invalidSettings(file, `${key} must not be blank`);
  if (hasSecretControlCharacter(secret)) {
    throw invalidSettings(file, `${key} must not contain control characters`);
  }
  return secret;
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

function validateSettingsRelations(settings: SashSettings, file: string): void {
  const controller = parseControllerAddress(settings.controller);
  if (!controller) {
    throw invalidSettings(file, "controller must be a loopback host:port controller address");
  }
  const ports: Array<[string, number]> = [
    ["mixedPort", settings.mixedPort],
    ["daemonPort", settings.daemonPort],
    ["controller", controller.port],
  ];
  for (let i = 0; i < ports.length; i++) {
    for (let j = i + 1; j < ports.length; j++) {
      if (ports[i]?.[1] === ports[j]?.[1]) {
        throw invalidSettings(
          file,
          `${ports[i]?.[0]} and ${ports[j]?.[0]} must use different ports`,
        );
      }
    }
  }
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
    parseSecret,
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
    parseSecret,
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

  // Only omitted historical fields receive a generated value. A present blank
  // secret is invalid: silently changing it would make the in-memory value
  // diverge from the caller's requested settings.
  const normalizedSecret = secret.missing ? generateSecret() : secret.value;
  const normalizedDaemonSecret = daemonSecret.missing ? generateSecret() : daemonSecret.value;

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
  validateSettingsRelations(settings, file);

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

/** Validate, canonicalize, persist and return the exact value written to disk. */
export function saveSettings(
  settings: SashSettings,
  layout: SashLayout = sashLayout(),
): SashSettings {
  const lease = acquireStateLockSync(layout.settingsLockFile, { purpose: "settings" });
  try {
    const parsed = parseSettings(settings, layout.settingsFile, false);
    writeCanonicalSettings(parsed.settings, layout);
    return parsed.settings;
  } finally {
    lease.release();
  }
}

/**
 * Parse raw sash.json text for the settings file editor. Strict: every field
 * must be present (the editor always starts from a complete canonical file),
 * unknown fields are rejected, and nothing is written.
 */
export function parseSettingsText(text: string, file = "sash.json"): SashSettings {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Settings file is invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseSettings(document, file, false).settings;
}

/**
 * Validate a complete settings candidate with the same canonical rules used by
 * persistence, keeping errors free of a filesystem path. Returns the
 * canonicalized settings (loopback controller address normalized).
 */
export function validateSettingsCandidate(candidate: SashSettings): SashSettings {
  return parseSettings(candidate, "candidate settings", false).settings;
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
