import crypto from "node:crypto";
import fs from "node:fs";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { type SashLayout, sashLayout } from "./paths.js";

/** Sash's own settings, persisted to <root>/sash.json. */
export interface SashSettings {
  /** Clash/mihomo-format subscription URL; empty means unmanaged config. */
  subscriptionUrl: string;
  mixedPort: number;
  /** external-controller listen address, e.g. 127.0.0.1:9090 */
  controller: string;
  /** API secret for the external-controller. */
  secret: string;
  /** Enable TUN inbound in the generated config (requires admin/root). */
  tun: boolean;
  /** Installed mihomo core version tag, e.g. v1.19.30; empty when unknown. */
  coreVersion: string;
  /** Installed MetaCubeXD version tag; empty when not installed. */
  uiVersion: string;
  /** allow-lan toggle for the generated config. */
  allowLan: boolean;
}

export const DEFAULT_SETTINGS: SashSettings = {
  subscriptionUrl: "",
  mixedPort: 7890,
  controller: "127.0.0.1:9090",
  secret: "",
  tun: false,
  coreVersion: "",
  uiVersion: "",
  allowLan: false,
};

export function generateSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function loadSettings(layout: SashLayout = sashLayout()): SashSettings {
  let raw: Partial<SashSettings> = {};
  try {
    raw = JSON.parse(fs.readFileSync(layout.settingsFile, "utf8")) as Partial<SashSettings>;
  } catch {
    // missing or corrupt: fall back to defaults
  }
  const merged: SashSettings = {
    ...DEFAULT_SETTINGS,
    ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== null)),
  } as SashSettings;
  if (!merged.secret) {
    merged.secret = generateSecret();
    saveSettings(merged, layout);
  }
  return merged;
}

export function saveSettings(settings: SashSettings, layout: SashLayout = sashLayout()): void {
  atomicWriteFileSync(layout.settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
}
