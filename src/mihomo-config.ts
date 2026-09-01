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
 * tun, allow-lan). Everything else — proxies, proxy-groups, rules, dns —
 * comes from the user's Clash/mihomo-format subscription, or from existing
 * config on disk, or from a built-in DIRECT-only default.
 */

export interface GeneratedConfig {
  yaml: string;
  proxyCount: number;
  source: "subscription" | "existing" | "default";
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
  return (
    ("proxies" in rec && Array.isArray(rec.proxies)) ||
    ("proxy-providers" in rec &&
      typeof rec["proxy-providers"] === "object" &&
      rec["proxy-providers"] !== null &&
      !Array.isArray(rec["proxy-providers"])) ||
    ("rules" in rec && Array.isArray(rec.rules))
  );
}

export function readExistingConfigDoc(
  layout: SashLayout = sashLayout(),
): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(layout.configFile)) return undefined;
    const raw = fs.readFileSync(layout.configFile, "utf8");
    const doc = YAML.parse(raw);
    if (isValidMihomoConfig(doc)) {
      return doc;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Traffic quota advertised by a subscription gateway (`subscription-userinfo`). */
export interface SubscriptionUserinfo {
  upload: number;
  download: number;
  total: number;
  /** Unix epoch seconds. */
  expire?: number;
}

/** A fetched subscription document plus the metadata gateways send as headers. */
export interface SubscriptionFetch {
  doc: Record<string, unknown>;
  /** Raw response body, stored verbatim as the local profile file. */
  yamlText: string;
  /** Display name from Content-Disposition, when provided. */
  name?: string;
  subInfo?: SubscriptionUserinfo;
  /** `profile-web-page-url` header. */
  homePage?: string;
  /** `profile-update-interval` header, in hours. */
  intervalHours?: number;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Parse `subscription-userinfo: upload=..; download=..; total=..; expire=..`. */
export function parseSubscriptionUserinfo(
  header: string | undefined,
): SubscriptionUserinfo | undefined {
  if (!header) return undefined;
  const nums: Partial<Record<keyof SubscriptionUserinfo, number>> = {};
  const knownKeys = new Set(["upload", "download", "total", "expire"]);
  for (const pair of header.split(";")) {
    const [k, v] = pair.split("=", 2);
    const key = k?.trim() ?? "";
    if (!knownKeys.has(key)) continue;
    const n = Number(v?.trim());
    if (Number.isFinite(n) && n >= 0) nums[key as keyof SubscriptionUserinfo] = n;
  }
  if (nums.upload === undefined || nums.download === undefined || nums.total === undefined) {
    return undefined;
  }
  return {
    upload: nums.upload,
    download: nums.download,
    total: nums.total,
    ...(nums.expire !== undefined && nums.expire > 0 ? { expire: nums.expire } : {}),
  };
}

/** Parse a display filename out of a Content-Disposition header. */
export function parseContentDispositionFilename(header: string | undefined): string | undefined {
  if (!header) return undefined;
  // RFC 5987 form: filename*=UTF-8''<percent-encoded>
  const ext = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (ext?.[1]) {
    try {
      const decoded = decodeURIComponent(ext[1].trim()).trim();
      if (decoded) return stripYamlExt(decoded);
    } catch {
      // fall through to the plain form
    }
  }
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/);
  const value = plain?.[1]?.trim();
  return value ? stripYamlExt(value) : undefined;
}

function stripYamlExt(name: string): string {
  return name.replace(/\.(ya?ml)$/i, "");
}

function parseIntervalHours(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const n = Number(header.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function parseSafeHttpUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch a subscription URL, validating the document and extracting the
 * metadata headers subscription gateways send (usage quota, update interval,
 * display name, home page).
 */
export async function fetchSubscriptionProfile(url: string): Promise<SubscriptionFetch> {
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
  return {
    doc,
    yamlText: text,
    name: parseContentDispositionFilename(firstHeader(res.headers["content-disposition"])),
    subInfo: parseSubscriptionUserinfo(firstHeader(res.headers["subscription-userinfo"])),
    homePage: parseSafeHttpUrl(firstHeader(res.headers["profile-web-page-url"])),
    intervalHours: parseIntervalHours(firstHeader(res.headers["profile-update-interval"])),
  };
}

export async function fetchSubscription(url: string): Promise<Record<string, unknown>> {
  const { doc } = await fetchSubscriptionProfile(url);
  return doc;
}

/** Keys Sash always controls; user/subscription values for these are dropped. */
const MANAGED_KEYS = new Set([
  "mixed-port",
  "port",
  "socks-port",
  "redir-port",
  "tproxy-port",
  "authentication",
  "external-controller",
  "external-controller-tls",
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
  /** Subscription document; when absent, existing config or default is used. */
  subscription?: Record<string, unknown>;
}

export function renderConfig(
  base: Record<string, unknown>,
  settings: SashSettings,
  source: GeneratedConfig["source"],
): GeneratedConfig {
  const merged = overlayManagedKeys(base, settings);
  const proxies = merged.proxies;
  return {
    yaml: YAML.stringify(merged, { indent: 2 }),
    proxyCount: Array.isArray(proxies) ? proxies.length : 0,
    source,
  };
}

export async function generateConfig(opts: GenerateOptions): Promise<GeneratedConfig> {
  const layout = opts.layout ?? sashLayout();
  const existing = opts.subscription === undefined ? readExistingConfigDoc(layout) : undefined;
  const result = opts.subscription
    ? renderConfig(opts.subscription, opts.settings, "subscription")
    : existing
      ? renderConfig(existing, opts.settings, "existing")
      : renderConfig(buildDefaultConfig(), opts.settings, "default");
  atomicWriteFileSync(layout.configFile, result.yaml);
  return result;
}

export function configExists(layout: SashLayout = sashLayout()): boolean {
  return fs.existsSync(layout.configFile);
}
