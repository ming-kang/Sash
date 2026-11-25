import { mapping } from "./json-shape.js";
import type { TunSettings } from "./tun-settings.js";

/** TUN keys Sash owns outright; a profile's value for one is ignored. */
const TUN_MANAGED_KEYS = [
  "enable",
  "stack",
  "auto-route",
  "strict-route",
  "auto-detect-interface",
  "device",
] as const;

function unionStrings(...values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && !out.includes(item)) out.push(item);
    }
  }
  return out;
}

function removeTunListeners(config: Record<string, unknown>, warnings: string[]): void {
  const listeners = config.listeners;
  if (!Array.isArray(listeners)) return;
  const kept = listeners.filter(
    (entry) => !(mapping(entry) && String(entry.type).toLowerCase() === "tun"),
  );
  if (kept.length !== listeners.length) {
    warnings.push(
      "profile TUN listeners are not supported and were removed; use Sash TUN settings",
    );
    config.listeners = kept;
  }
}

function mergeManagedTunKeys(
  config: Record<string, unknown>,
  tun: TunSettings,
  warnings: string[],
): void {
  const profileTun = mapping(config.tun) ? config.tun : {};
  const managedTun: Record<string, unknown> = {
    enable: tun.enable,
    ...(tun.enable
      ? {
          stack: tun.stack,
          "auto-route": tun.autoRoute,
          "strict-route": tun.strictRoute,
          "auto-detect-interface": true,
          ...(tun.device !== undefined ? { device: tun.device } : {}),
          "dns-hijack": unionStrings(profileTun["dns-hijack"], tun.dnsHijack),
          "route-exclude-address": unionStrings(
            profileTun["route-exclude-address"],
            tun.routeExcludeAddress,
          ),
        }
      : {}),
  };
  for (const key of TUN_MANAGED_KEYS) {
    if (
      key in managedTun &&
      key in profileTun &&
      JSON.stringify(profileTun[key]) !== JSON.stringify(managedTun[key])
    ) {
      warnings.push(`profile tun.${key} is managed by Sash TUN settings; its value was ignored`);
    }
  }
  config.tun = { ...profileTun, ...managedTun };
}

// macOS leaves the system DNS untouched when tun.dns-mode is empty, so LAN
// resolvers bypass the tunnel; a profile that pins the key keeps its choice.
function defaultSystemDnsMode(config: Record<string, unknown>): void {
  if (process.platform !== "darwin") return;
  const section = mapping(config.tun) ? config.tun : undefined;
  if (!section || "dns-mode" in section) return;
  section["dns-mode"] = "native";
}

const DIRECT_EMPTY_FALLBACKS = new Set(["DIRECT", "COMPATIBLE", "PASS"]);

function failClosedEmptyGroups(config: Record<string, unknown>, warnings: string[]): void {
  const value = config["proxy-groups"];
  if (!Array.isArray(value)) return;
  for (const group of value.filter(mapping)) {
    const name = typeof group.name === "string" ? group.name : "unnamed";
    const raw = group["empty-fallback"];
    const fallback = typeof raw === "string" ? raw.trim() : "";
    if (!fallback) {
      group["empty-fallback"] = "REJECT";
    } else if (DIRECT_EMPTY_FALLBACKS.has(fallback.toUpperCase())) {
      group["empty-fallback"] = "REJECT";
      warnings.push(
        `proxy group ${name} used ${fallback} as its empty fallback; direct traffic from an empty group exposes the real egress, so Sash uses REJECT`,
      );
    }
  }
}

function hardenTunNetworking(config: Record<string, unknown>, warnings: string[]): void {
  if (config.dns !== undefined && !mapping(config.dns))
    warnings.push("profile dns is not a mapping; replaced with Core DNS defaults");
  const dns = (mapping(config.dns) ? config.dns : undefined) ?? {
    nameserver: ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"],
  };
  if (dns.enable === false)
    warnings.push("profile dns.enable: false ignored; TUN requires the Core DNS resolver");
  config.dns = { listen: "127.0.0.1:1053", "enhanced-mode": "fake-ip", ...dns, enable: true };
}

export function tunDisabledDocument(config: Record<string, unknown>): Record<string, unknown> {
  return { ...config, tun: { enable: false } };
}

/**
 * Apply the complete TUN policy at every final generation boundary. Profile
 * rendering and generation plugins both end here, so a plugin cannot leave a
 * weaker, differently merged TUN configuration than the normal render path.
 */
// Applied at the initial render and again after generation plugins over an
// already enforced document, so the composition must stay idempotent.
export function enforceTunConfiguration(
  config: Record<string, unknown>,
  tun: TunSettings,
  warnings: string[] = [],
): void {
  removeTunListeners(config, warnings);
  mergeManagedTunKeys(config, tun, warnings);
  failClosedEmptyGroups(config, warnings);
  if (tun.enable) {
    defaultSystemDnsMode(config);
    hardenTunNetworking(config, warnings);
  }
}
