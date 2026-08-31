import fs from "node:fs";
import YAML from "yaml";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { fetchWithRetry } from "./http.js";
import { type SashLayout, sashLayout } from "./paths.js";
import type { SashSettings } from "./settings.js";

/**
 * Generates mihomo's config.yaml.
 *
 * Sash owns a fixed set of operational keys (ports, controller, secret,
 * external-ui, tun). Everything else — proxies, proxy-groups, rules, dns —
 * comes from the user's Clash/mihomo-format subscription, or from a built-in
 * DIRECT-only default so the core always boots.
 */

export interface GeneratedConfig {
  yaml: string;
  proxyCount: number;
  source: "subscription" | "default";
}

export function buildDefaultConfig(): Record<string, unknown> {
  return {
    mode: "rule",
    "log-level": "info",
    ipv6: true,
    proxies: [],
    "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["DIRECT"] }],
    rules: ["MATCH,PROXY"],
  };
}

export function isValidMihomoConfig(doc: unknown): doc is Record<string, unknown> {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return false;
  const rec = doc as Record<string, unknown>;
  // A Clash/mihomo subscription must define proxies and/or rules; a bare node
  // list (v2ray/ss share links) or base64 blob will fail YAML parsing anyway,
  // but some subs return YAML that is not a Clash config — reject those early.
  return "proxies" in rec || "proxy-providers" in rec || "rules" in rec;
}

export async function fetchSubscription(url: string): Promise<Record<string, unknown>> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid subscription URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Subscription URL must be http(s): ${url}`);
  }
  const res = await fetchWithRetry(url, {
    attempts: 3,
    timeoutMs: 30_000,
    // A clash-format UA hints subscription gateways to return Clash config.
    headers: { "user-agent": "clash.meta; mihomo; sash" },
  });
  if (res.statusCode !== 200) {
    throw new Error(`Subscription fetch failed: HTTP ${res.statusCode}`);
  }
  const text = await res.text();
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new Error(
      `Subscription is not valid YAML (Clash/mihomo format required): ${(err as Error).message}`,
    );
  }
  if (!isValidMihomoConfig(doc)) {
    throw new Error(
      "Subscription content is not a Clash/mihomo config (missing proxies/rules). " +
        "Convert non-Clash subscriptions with a subconverter first.",
    );
  }
  return doc;
}

/** Keys Sash always controls; user/subscription values for these are dropped. */
const MANAGED_KEYS = new Set([
  "mixed-port",
  "port",
  "socks-port",
  "external-controller",
  "external-ui",
  "external-ui-url",
  "external-ui-name",
  "secret",
  "tun",
  "allow-lan",
]);

export function overlayManagedKeys(
  base: Record<string, unknown>,
  settings: SashSettings,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!MANAGED_KEYS.has(key)) out[key] = value;
  }
  out["mixed-port"] = settings.mixedPort;
  out["allow-lan"] = settings.allowLan;
  out["external-controller"] = settings.controller;
  out.secret = settings.secret;
  if (settings.tun) {
    out.tun = {
      enable: true,
      stack: "mixed",
      "auto-route": true,
      "auto-detect-interface": true,
      "dns-hijack": ["any:53"],
    };
  }
  return out;
}

export interface GenerateOptions {
  layout?: SashLayout;
  settings: SashSettings;
  /** Subscription document; when absent, the built-in default is used. */
  subscription?: Record<string, unknown>;
}

export async function generateConfig(opts: GenerateOptions): Promise<GeneratedConfig> {
  const layout = opts.layout ?? sashLayout();
  const base = opts.subscription ?? buildDefaultConfig();
  const merged = overlayManagedKeys(base, opts.settings);
  const proxies = merged.proxies;
  const proxyCount = Array.isArray(proxies) ? proxies.length : 0;
  const yamlText = YAML.stringify(merged, { indent: 2 });
  atomicWriteFileSync(layout.configFile, yamlText);
  return {
    yaml: yamlText,
    proxyCount,
    source: opts.subscription ? "subscription" : "default",
  };
}

export function configExists(layout: SashLayout = sashLayout()): boolean {
  return fs.existsSync(layout.configFile);
}
