import crypto from "node:crypto";
import fs from "node:fs";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { type SashLayout, sashLayout } from "./paths.js";

/** Sash's own settings, persisted to <root>/sash.json. */
export interface SashSettings {
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
  mixedPort: 17890,
  controller: "127.0.0.1:9090",
  secret: "",
  tun: false,
  allowLan: false,
  daemonPort: 19090,
  daemonSecret: "",
  systemProxy: false,
};

export function generateSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function loadSettings(layout: SashLayout = sashLayout()): SashSettings {
  let raw: Partial<SashSettings> = {};
  try {
    const text = fs.readFileSync(layout.settingsFile, "utf8");
    try {
      raw = JSON.parse(text) as Partial<SashSettings>;
    } catch (err) {
      throw new Error(
        `Settings file is invalid JSON: ${layout.settingsFile}: ${(err as Error).message}`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const merged: SashSettings = {
    ...DEFAULT_SETTINGS,
    ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== null)),
  } as SashSettings;
  let dirty = false;
  if (!merged.secret) {
    merged.secret = generateSecret();
    dirty = true;
  }
  if (!merged.daemonSecret) {
    merged.daemonSecret = generateSecret();
    dirty = true;
  }
  if (dirty) saveSettings(merged, layout);
  return merged;
}

export function saveSettings(settings: SashSettings, layout: SashLayout = sashLayout()): void {
  atomicWriteFileSync(layout.settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
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

export function validateController(v: string): boolean {
  const trimmed = v.trim();
  if (!trimmed) return false;
  if (/[\s/?#@]/.test(trimmed)) return false;
  const match = trimmed.match(/^(.*):(\d+)$/);
  const hostPart = match?.[1];
  const portPart = match?.[2];
  if (!hostPart || !portPart) return false;
  const port = Number.parseInt(portPart, 10);
  if (port < 1 || port > 65535) return false;
  try {
    const url = new URL(`http://${trimmed}`);
    if (!url.hostname) return false;
    if (url.username || url.password) return false;
    if (url.pathname !== "/" || url.search || url.hash) return false;
    return true;
  } catch {
    return false;
  }
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
      if (!v || !validateController(v)) {
        throw new Error(`invalid controller address: ${v} (expected host:port)`);
      }
      settings.controller = v;
      break;
    }
    case "secret":
      settings.secret = !value || value === "regenerate" ? generateSecret() : value.trim();
      break;
    default:
      throw new Error(`unknown key: ${key} (settable: ${SETTABLE_KEYS.join(", ")})`);
  }
}
