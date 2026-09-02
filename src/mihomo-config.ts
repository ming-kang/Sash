import { isIP } from "node:net";
import YAML from "yaml";
import { ERROR_BODY_LIMIT, fetchWithRetry } from "./http.js";
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

/**
 * Fetch a subscription URL, validating the document and extracting the
 * metadata headers subscription gateways send (usage quota, update interval,
 * display name, home page).
 */
export const PROFILE_DOWNLOAD_SIZE_LIMIT = 8 * 1024 * 1024;
const MAX_SUBSCRIPTION_REDIRECTS = 5;
const PROFILE_FETCH_DEADLINE_MS = 30_000;

function isRestrictedIpv4Address(parts: number[]): boolean {
  const [a = 0, b = 0, c = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6Bytes(host: string): Uint8Array | undefined {
  const pieces = host.toLowerCase().split("::");
  if (pieces.length > 2) return undefined;
  const parseSide = (side: string): number[] | undefined => {
    if (!side) return [];
    const words: number[] = [];
    for (const token of side.split(":")) {
      if (token.includes(".")) {
        const ipv4 = token.split(".").map(Number);
        if (
          ipv4.length !== 4 ||
          ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
        ) {
          return undefined;
        }
        words.push(((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0));
        words.push(((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(token)) return undefined;
      words.push(Number.parseInt(token, 16));
    }
    return words;
  };
  const left = parseSide(pieces[0] ?? "");
  const right = parseSide(pieces[1] ?? "");
  if (!left || !right) return undefined;
  const omitted = 8 - left.length - right.length;
  if ((pieces.length === 1 && omitted !== 0) || (pieces.length === 2 && omitted < 1)) {
    return undefined;
  }
  const words = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  if (words.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? 0;
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

function isRestrictedIpv6Address(host: string): boolean {
  const bytes = parseIpv6Bytes(host);
  if (!bytes) return true;
  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  if (allZero || loopback) return true;

  const compatiblePrefix = bytes.slice(0, 12).every((byte) => byte === 0);
  const mappedPrefix =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const translatedPrefix =
    bytes.slice(0, 8).every((byte) => byte === 0) &&
    bytes[8] === 0xff &&
    bytes[9] === 0xff &&
    bytes[10] === 0 &&
    bytes[11] === 0;
  const wellKnownNat64Prefix =
    bytes[0] === 0 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  if (compatiblePrefix || mappedPrefix || translatedPrefix || wellKnownNat64Prefix) {
    return isRestrictedIpv4Address(Array.from(bytes.slice(12)));
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isRestrictedIpv4Address(Array.from(bytes.slice(2, 6))); // 6to4
  }

  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return true; // fc00::/7 ULA
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) >= 0x80) return true; // link/site local
  if (bytes[0] === 0xff) return true; // multicast
  if (bytes[0] === 0x01 && bytes.slice(1, 8).every((byte) => byte === 0)) return true; // discard
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return true; // documentation
  }
  return false;
}

function isRestrictedSubscriptionHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) {
    return isRestrictedIpv4Address(host.split(".").map(Number));
  }
  if (isIP(host) === 6) return isRestrictedIpv6Address(host);
  return false;
}

/**
 * Apply subscription redirect restrictions without DNS resolution. DNS is not
 * resolved here because remote subscription traffic may intentionally use an
 * environment proxy; resolving locally would not describe the peer contacted.
 */
export function resolveSubscriptionRedirect(initial: URL, current: URL, location: string): URL {
  const target = new URL(location, current);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Refusing subscription redirect to non-http(s) URL: ${target.href}`);
  }
  if (current.protocol === "https:" && target.protocol === "http:") {
    throw new Error(`Refusing HTTPS-to-HTTP subscription redirect: ${target.href}`);
  }
  const initialRestricted = isRestrictedSubscriptionHost(initial.hostname);
  const targetRestricted = isRestrictedSubscriptionHost(target.hostname);
  if (initialRestricted && target.origin !== initial.origin) {
    throw new Error(`Refusing subscription redirect away from restricted origin: ${target.href}`);
  }
  if (!initialRestricted && targetRestricted) {
    throw new Error(`Refusing subscription redirect to restricted host: ${target.hostname}`);
  }
  return target;
}

export async function fetchSubscriptionProfile(url: string): Promise<SubscriptionFetch> {
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
    await res.text(ERROR_BODY_LIMIT);
    throw new Error(`Subscription fetch failed: HTTP ${res.statusCode}`);
  }
  const text = await res.text(PROFILE_DOWNLOAD_SIZE_LIMIT);
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
