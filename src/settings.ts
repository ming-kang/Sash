import crypto from "node:crypto";
import { isPlainObject } from "./json-shape.js";

/** Settings owned by sashd. Listener addresses and credentials are boot settings. */
export interface SashSettings {
  mixedPort: number;
  controller: string;
  secret: string;
  allowLan: boolean;
  daemonPort: number;
  daemonSecret: string;
  systemProxy: boolean;
}

export type PublicSashSettings = Omit<SashSettings, "secret" | "daemonSecret">;

// The source launcher selects separate defaults; initialization still belongs to sashd.
const development = process.env.SASH_DEVELOPMENT === "1";
export const DEFAULT_SETTINGS: SashSettings = {
  mixedPort: development ? 18890 : 7890,
  controller: development ? "127.0.0.1:18990" : "127.0.0.1:9090",
  secret: "",
  allowLan: false,
  daemonPort: development ? 28990 : 19090,
  daemonSecret: "",
  systemProxy: false,
};

export function generateSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function initialSettings(): SashSettings {
  return { ...DEFAULT_SETTINGS, secret: generateSecret(), daemonSecret: generateSecret() };
}

export function publicSettings(settings: SashSettings): PublicSashSettings {
  return {
    mixedPort: settings.mixedPort,
    controller: settings.controller,
    allowLan: settings.allowLan,
    daemonPort: settings.daemonPort,
    systemProxy: settings.systemProxy,
  };
}

export interface ControllerAddress {
  host: "127.0.0.1" | "localhost" | "::1";
  port: number;
  canonical: string;
}

/** A controller credential must never leave loopback. */
export function parseControllerAddress(value: string): ControllerAddress | undefined {
  const match = value.trim().match(/^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/i);
  const rawHost = match?.[1]?.toLowerCase();
  const rawPort = match?.[2];
  if (!rawHost || !rawPort) return undefined;
  const port = Number(rawPort);
  if (port < 1 || port > 65_535 || String(port) !== rawPort) return undefined;
  if (rawHost === "[::1]") return { host: "::1", port, canonical: `[::1]:${port}` };
  const host = rawHost === "localhost" ? "localhost" : "127.0.0.1";
  return { host, port, canonical: `${host}:${port}` };
}

export function validateSettingsCandidate(value: unknown): SashSettings {
  if (!isPlainObject(value)) throw new Error("Settings must be a plain object");
  const keys = Object.keys(DEFAULT_SETTINGS);
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error("Settings contain an unknown field");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`Settings field ${key} is required`);
  }
  const port = (key: "mixedPort" | "daemonPort"): number => {
    const number = value[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > 65_535) {
      throw new Error(`${key} must be an integer from 1 to 65535`);
    }
    return number;
  };
  const secret = (key: "secret" | "daemonSecret"): string => {
    const text = value[key];
    if (typeof text !== "string" || !text.trim()) throw new Error(`${key} must not be blank`);
    if ([...text].some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)) {
      throw new Error(`${key} must not contain control characters`);
    }
    return text;
  };
  const boolean = (key: "allowLan" | "systemProxy"): boolean => {
    if (typeof value[key] !== "boolean") throw new Error(`${key} must be a boolean`);
    return value[key];
  };
  const controller =
    typeof value.controller === "string" && parseControllerAddress(value.controller);
  if (!controller) throw new Error("controller must be a loopback host:port address");
  const result: SashSettings = {
    mixedPort: port("mixedPort"),
    controller: controller.canonical,
    secret: secret("secret"),
    allowLan: boolean("allowLan"),
    daemonPort: port("daemonPort"),
    daemonSecret: secret("daemonSecret"),
    systemProxy: boolean("systemProxy"),
  };
  assertDistinctPorts(result.mixedPort, result.daemonPort, controller.port);
  return result;
}

/**
 * Lenient read for the stored manifest: unknown keys are ignored and a damaged
 * value falls back to its default. Port collisions stay fatal — they cannot work.
 */
export function parseStoredSettings(value: unknown): SashSettings {
  if (!isPlainObject(value)) throw new Error("Settings must be a plain object");
  const port = (key: "mixedPort" | "daemonPort"): number => {
    const number = value[key];
    return typeof number === "number" && Number.isInteger(number) && number >= 1 && number <= 65_535
      ? number
      : DEFAULT_SETTINGS[key];
  };
  const secret = (key: "secret" | "daemonSecret"): string => {
    const text = value[key];
    if (typeof text !== "string") return DEFAULT_SETTINGS[key];
    return [...text]
      .filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)
      .join("");
  };
  const boolean = (key: "allowLan" | "systemProxy"): boolean =>
    typeof value[key] === "boolean" ? value[key] : DEFAULT_SETTINGS[key];
  const controller =
    parseControllerAddress(typeof value.controller === "string" ? value.controller : "") ??
    parseControllerAddress(DEFAULT_SETTINGS.controller);
  if (!controller) throw new Error("controller must be a loopback host:port address");
  const result: SashSettings = {
    mixedPort: port("mixedPort"),
    controller: controller.canonical,
    secret: secret("secret"),
    allowLan: boolean("allowLan"),
    daemonPort: port("daemonPort"),
    daemonSecret: secret("daemonSecret"),
    systemProxy: boolean("systemProxy"),
  };
  assertDistinctPorts(result.mixedPort, result.daemonPort, controller.port);
  return result;
}

function assertDistinctPorts(mixedPort: number, daemonPort: number, controllerPort: number): void {
  if (new Set([mixedPort, daemonPort, controllerPort]).size !== 3)
    throw new Error("mixedPort, daemonPort and controller must use different ports");
}
