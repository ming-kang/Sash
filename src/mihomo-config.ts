import YAML from "yaml";
import { parseCoreYaml } from "./core-yaml.js";
import { fetchWithRetry, readErrorSummary } from "./http.js";
import type { SashSettings } from "./settings.js";

/**
 * Generates mihomo's config.yaml.
 *
 * Sash owns a fixed set of operational keys (ports, controller, secret,
 * tun, allow-lan). Everything else — proxies, proxy-groups, rules, dns —
 * comes from the active local/remote profile or from a built-in DIRECT-only
 * default.
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

export function asCoreConfigDocument(doc: unknown): Record<string, unknown> {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error(
      "Subscription content is not a core configuration document; " +
        "request a core-format YAML subscription from the provider.",
    );
  }
  return doc as Record<string, unknown>;
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
    if (!v?.trim()) continue;
    const n = Number(v.trim());
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
      const decoded = sanitizeFilename(decodeURIComponent(ext[1].trim()));
      if (decoded) return stripYamlExt(decoded);
    } catch {
      // fall through to the plain form
    }
  }
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/);
  const value = plain?.[1] ? sanitizeFilename(plain[1]) : undefined;
  return value ? stripYamlExt(value) : undefined;
}

const C0_OR_DEL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g",
);

function sanitizeFilename(name: string): string {
  return name.replace(C0_OR_DEL, "").trim();
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

export const PROFILE_DOWNLOAD_SIZE_LIMIT = 8 * 1024 * 1024;
const MAX_SUBSCRIPTION_REDIRECTS = 5;
const PROFILE_FETCH_DEADLINE_MS = 30_000;

/** Subscription redirects must stay on an absolute http(s) URL. */
export function resolveSubscriptionRedirect(_initial: URL, current: URL, location: string): URL {
  const target = new URL(location, current);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Refusing subscription redirect to non-http(s) URL: ${target.href}`);
  }
  return target;
}

export async function fetchSubscriptionProfile(
  url: string,
  signal?: AbortSignal,
): Promise<SubscriptionFetch> {
  let initial: URL;
  try {
    initial = new URL(url);
  } catch {
    throw new Error(`Invalid subscription URL: ${url}`);
  }
  if (initial.protocol !== "https:" && initial.protocol !== "http:") {
    throw new Error(`Subscription URL must be http(s): ${url}`);
  }

  const deadlineAt = Date.now() + PROFILE_FETCH_DEADLINE_MS;
  let current = initial;
  let res: Awaited<ReturnType<typeof fetchWithRetry>>;
  for (let redirects = 0; ; redirects += 1) {
    const remainingDeadlineMs = deadlineAt - Date.now();
    if (remainingDeadlineMs <= 0) {
      throw new Error(`Subscription fetch deadline exceeded after ${PROFILE_FETCH_DEADLINE_MS}ms`);
    }
    res = await fetchWithRetry(current.href, {
      signal,
      attempts: 3,
      deadlineMs: remainingDeadlineMs,
      manualRedirect: true,
      // A clash-format UA hints subscription gateways to return Clash config.
      headers: { "user-agent": "clash.meta; mihomo; sash" },
    });
    if (res.statusCode < 300 || res.statusCode >= 400) break;
    const locationHeader = firstHeader(res.headers.location);
    await res.discard();
    if (!locationHeader) throw new Error(`Subscription fetch failed: HTTP ${res.statusCode}`);
    if (redirects >= MAX_SUBSCRIPTION_REDIRECTS) {
      throw new Error(`Too many subscription redirects (>${MAX_SUBSCRIPTION_REDIRECTS})`);
    }
    current = resolveSubscriptionRedirect(initial, current, locationHeader);
  }

  if (res.statusCode !== 200) {
    await readErrorSummary(res);
    throw new Error(`Subscription fetch failed: HTTP ${res.statusCode}`);
  }
  const text = await res.text(PROFILE_DOWNLOAD_SIZE_LIMIT);
  const doc = asCoreConfigDocument(parseCoreYaml(text));
  return {
    doc,
    yamlText: text,
    name: parseContentDispositionFilename(firstHeader(res.headers["content-disposition"])),
    subInfo: parseSubscriptionUserinfo(firstHeader(res.headers["subscription-userinfo"])),
    homePage: parseSafeHttpUrl(firstHeader(res.headers["profile-web-page-url"])),
    intervalHours: parseIntervalHours(firstHeader(res.headers["profile-update-interval"])),
  };
}

/**
 * Geodata URLs used only when the Core cannot fetch its databases directly.
 * mihomo downloads geodata from `geox-url` on demand; the upstream defaults
 * point at github.com, which is unreachable on some networks, and the Core
 * cannot use the proxy it has not started yet. These mirrors are transports
 * for public data, exactly like the Core release mirrors.
 */
export const GEOX_MIRRORS = {
  geoip:
    "https://ghfast.top/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat",
  geosite:
    "https://ghfast.top/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat",
  mmdb: "https://ghfast.top/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country.mmdb",
  asn: "https://ghfast.top/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb",
} as const;

/** Rewrite an already generated configuration to fetch geodata through mirrors. */
export function withGeodataMirrors(generated: GeneratedConfig): GeneratedConfig {
  const doc = asCoreConfigDocument(parseCoreYaml(generated.yaml));
  doc["geox-url"] = { ...GEOX_MIRRORS };
  return { ...generated, yaml: YAML.stringify(doc, { indent: 2 }) };
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
  "external-controller-unix",
  "external-controller-pipe",
  "external-ui",
  "external-ui-url",
  "external-ui-name",
  "secret",
  "tun",
  "tunnels",
  "allow-lan",
]);

export function stripManagedKeys(base: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(base).filter(([key]) => !MANAGED_KEYS.has(key)));
}

export function overlayManagedKeys(
  base: Record<string, unknown>,
  settings: SashSettings,
): Record<string, unknown> {
  const out = stripManagedKeys(base);
  out["mixed-port"] = settings.mixedPort;
  out["allow-lan"] = settings.allowLan;
  out["external-controller"] = settings.controller;
  out.secret = settings.secret;
  // The generated runtime configuration always disables the TUN listener.
  out.tun = { enable: false };
  return out;
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
