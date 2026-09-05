import { createHash } from "node:crypto";
import fs, { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { downloadReleaseAsset, listReleaseAssets, parseSha256Digest } from "./github.js";
import { fetchWithRetry } from "./http.js";
import { resolveSubscriptionRedirect } from "./mihomo-config.js";
import type { SashLayout } from "./paths.js";

const PROVIDER_LIMIT = 8 * 1024 * 1024;
const GEO_LIMIT = 64 * 1024 * 1024;
const TOTAL_LIMIT = 128 * 1024 * 1024;
export interface ServiceBundleOptions {
  fetch?: typeof fetchWithRetry;
  listReleaseAssets?: typeof listReleaseAssets;
  downloadReleaseAsset?: typeof downloadReleaseAsset;
  now?: () => number;
  /** Absolute provider budget; trusted geodata has a separate 90-second budget. */
  deadlineMs?: number;
}
export interface ServiceBundle {
  config: Record<string, unknown>;
  assets: Array<{ path: string; data: string }>;
  /** Non-enumerable scheduling hint; never part of the native wire document. */
  readonly refreshMs?: number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Service bundle requires a YAML object");
  }
  return value as Record<string, unknown>;
}
function parse(text: string): Record<string, unknown> {
  try {
    const doc = YAML.parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML");
    return object(doc.toJS({ maxAliasCount: 50 }));
  } catch {
    // YAML diagnostics can contain subscription passwords or bearer URLs.
    throw new Error("Service bundle contains invalid or unsupported YAML");
  }
}
function safeRelative(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 220 ||
    /[\\:%]/.test(value) ||
    path.posix.normalize(value) !== value
  ) {
    throw new Error("Provider source must be a safe relative path under SASH_HOME");
  }
  const parts = value.split("/");
  if (
    parts.some(
      (p) =>
        !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}$/.test(p) ||
        p.endsWith(".") ||
        /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(p),
    )
  ) {
    throw new Error("Provider source must be a safe relative path under SASH_HOME");
  }
  return value;
}
async function readAsset(root: string, source: string, limit: number): Promise<Buffer> {
  const absolute = path.resolve(root, safeRelative(source));
  // Inspect every ancestor, including ancestors of SASH_HOME (junctions included).
  const chain: string[] = [];
  for (let cursor = absolute; ; cursor = path.dirname(cursor)) {
    chain.push(cursor);
    if (path.dirname(cursor) === cursor) break;
  }
  for (const entry of chain.reverse()) {
    if ((await lstat(entry)).isSymbolicLink())
      throw new Error("Service asset symlinks/junctions are forbidden");
  }
  if ((await realpath(absolute)) !== absolute)
    throw new Error("Service asset path is not canonical");
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > limit)
      throw new Error("Service asset must be a bounded nonempty regular file");
    const data = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let size = 0;
    while (size < data.length) {
      const result = await handle.read(data, size, data.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size !== stat.size) throw new Error("Service asset changed while reading");
    for (const entry of chain) {
      if ((await lstat(entry)).isSymbolicLink())
        throw new Error("Service asset ancestor changed while reading");
    }
    const final = await lstat(absolute);
    if (
      final.ino !== stat.ino ||
      final.dev !== stat.dev ||
      final.size !== stat.size ||
      final.mtimeMs !== stat.mtimeMs ||
      (await realpath(absolute)) !== absolute
    )
      throw new Error("Service asset changed while reading");
    return data.subarray(0, size);
  } finally {
    await handle.close();
  }
}

function assertCacheDirectory(directory: string): void {
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Service cache symlinks/junctions are forbidden");
    if (path.dirname(cursor) === cursor) break;
  }
  if (fs.realpathSync(directory) !== directory)
    throw new Error("Service cache path is not canonical");
}

/** Materialize untrusted providers in the user process; native policy still validates every proxy. */
export async function prepareServiceBundle(
  yaml: string,
  layout: SashLayout,
  options: ServiceBundleOptions = {},
): Promise<ServiceBundle> {
  if (Buffer.byteLength(yaml) > PROVIDER_LIMIT)
    throw new Error("Service config exceeds 8 MiB limit");
  const config = parse(yaml);
  const assets: ServiceBundle["assets"] = [];
  const now = options.now ?? Date.now;
  const budget = options.deadlineMs ?? 60_000;
  if (!Number.isSafeInteger(budget) || budget <= 0)
    throw new Error("Invalid service bundle deadline");
  const deadline = now() + budget;
  let total = Buffer.byteLength(JSON.stringify(config));
  let refreshMs: number | undefined;
  let geoText = JSON.stringify({
    rules: config.rules,
    dns: config.dns,
    "rule-providers": config["rule-providers"],
  }).toUpperCase();
  // Boolean geoip:false is not a reference; strings and policy keys still are.
  geoText = geoText.replace(/"GEOIP":(?:FALSE|TRUE)/g, "").replace(/"GEOIP-CODE":/g, "");
  const add = (dest: string, data: Buffer): void => {
    total += data.length;
    if (total > TOTAL_LIMIT || assets.length >= 512)
      throw new Error("Service bundle asset total exceeds limit");
    assets.push({ path: dest, data: data.toString("base64") });
  };
  for (const role of ["proxy-providers", "rule-providers"]) {
    if (!(role in config)) continue;
    const providers = object(config[role]);
    if (Object.keys(providers).length > 512) throw new Error("Too many service providers");
    for (const [name, value] of Object.entries(providers)) {
      const provider = object(value);
      if (
        role === "rule-providers" &&
        provider.format === "mrs" &&
        provider.behavior !== "domain" &&
        provider.behavior !== "ipcidr"
      )
        throw new Error("MRS requires domain or ipcidr behavior");
      if (provider.type === "inline") continue;
      if (provider.type !== "file" && provider.type !== "http")
        throw new Error("Unsupported service provider type");
      const remote = provider.type === "http";
      const source = remote ? provider.url : provider.path;
      if (typeof source !== "string") throw new Error("Service provider is missing its source");
      let data: Buffer;
      if (remote) {
        try {
          const initial = new URL(source);
          if (
            !["http:", "https:"].includes(initial.protocol) ||
            initial.username ||
            initial.password
          )
            throw new Error("Invalid URL");
          const headers: Record<string, string> = {};
          if (provider.header !== undefined) {
            for (const [key, value] of Object.entries(object(provider.header))) {
              const values = Array.isArray(value) ? value : [value];
              if (
                !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
                values.some((v) => typeof v !== "string" || /[\r\n\0]/.test(v))
              )
                throw new Error("Invalid provider header");
              headers[key] = values.join(", ");
            }
          }
          let current = initial;
          for (let hops = 0; ; hops++) {
            const remaining = deadline - now();
            if (remaining <= 0) throw new Error("deadline exceeded");
            const host = current.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
            const response = await (options.fetch ?? fetchWithRetry)(current.href, {
              headers: current.origin === initial.origin ? headers : {},
              attempts: 3,
              manualRedirect: true,
              deadlineMs: remaining,
              direct:
                host === "localhost" ||
                host.endsWith(".localhost") ||
                host === "::1" ||
                host.startsWith("127.") ||
                host.startsWith("::ffff:7f"),
            });
            if (response.statusCode >= 300 && response.statusCode < 400) {
              const location = response.headers.location;
              await response.discard();
              if (hops >= 5 || typeof location !== "string") throw new Error("Invalid redirect");
              current = resolveSubscriptionRedirect(initial, current, location);
              if (current.username || current.password) throw new Error("Credential redirect");
              continue;
            }
            if (response.statusCode !== 200) {
              await response.discard();
              throw new Error("HTTP failure");
            }
            data = await response.buffer(PROVIDER_LIMIT);
            if (now() >= deadline) throw new Error("deadline exceeded");
            break;
          }
        } catch {
          throw new Error(
            "Service provider download failed (HTTP/redirect policy, deadline or 8 MiB limit); check the provider source",
          );
        }
        const interval = provider.interval;
        if (
          interval !== undefined &&
          (typeof interval !== "number" ||
            !Number.isSafeInteger(interval) ||
            interval < 0 ||
            interval > 2147483647)
        )
          throw new Error("Invalid provider refresh interval");
        if (typeof interval === "number" && interval > 0)
          refreshMs = Math.min(refreshMs ?? Infinity, interval * 1000);
      } else {
        try {
          data = await readAsset(layout.root, safeRelative(source), PROVIDER_LIMIT);
        } catch {
          throw new Error(
            "Service provider source is missing or unsafe; supply a bounded regular file under canonical SASH_HOME (no symlinks or traversal)",
          );
        }
      }
      if (data.length === 0 || data.length > PROVIDER_LIMIT)
        throw new Error("Service provider exceeds bounded nonempty 8 MiB limit");
      let extension = provider.format ?? "yaml";
      if (role === "proxy-providers") {
        const proxies = parse(data.toString("utf8")).proxies;
        if (
          !Array.isArray(proxies) ||
          proxies.length > 20000 ||
          proxies.some(
            (p: unknown) =>
              !p ||
              typeof p !== "object" ||
              Array.isArray(p) ||
              typeof (p as Record<string, unknown>).type !== "string",
          )
        )
          throw new Error(
            "Service proxy provider requires a bounded proxies array of typed objects",
          );
        data = Buffer.from(JSON.stringify({ proxies }));
        extension = "json";
      } else if (!["yaml", "text", "mrs"].includes(String(extension))) {
        throw new Error("Unsupported service rule provider format");
      }
      if (role === "rule-providers" && extension !== "mrs") {
        let payload: unknown;
        if (extension === "yaml")
          payload = parse(new TextDecoder("utf-8", { fatal: true }).decode(data)).payload;
        else {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
          payload = text
            .replace(/^\uFEFF/, "")
            .replace(/\r\n/g, "\n")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"));
          if ((payload as string[]).some((line) => /[\\"'\r\uFEFF\0]/.test(line)))
            throw new Error("Ambiguous service rule text");
        }
        if (
          !Array.isArray(payload) ||
          payload.length > 10000 ||
          payload.some(
            (item: unknown) =>
              typeof item !== "string" || Buffer.byteLength(item) > 8192 || item.includes("\0"),
          )
        )
          throw new Error("Service rule provider requires a bounded string payload array");
        geoText += payload.join("\n").toUpperCase();
        data = Buffer.from(
          extension === "yaml" ? JSON.stringify({ payload }) : `${payload.join("\n")}\n`,
        );
      }
      if (data.length > PROVIDER_LIMIT) throw new Error("Converted provider exceeds 8 MiB limit");
      const dest = `providers/${createHash("sha256")
        .update(`${role}\0${name}\0${source}`)
        .digest("hex")}.${String(extension)}`;
      provider.type = "file";
      provider.path = dest;
      delete provider.url;
      delete provider.interval;
      delete provider.header;
      add(dest, data);
    }
  }
  const dns =
    config.dns && typeof config.dns === "object" && !Array.isArray(config.dns)
      ? object(config.dns)
      : {};
  const filter =
    dns["fallback-filter"] && typeof dns["fallback-filter"] === "object"
      ? object(dns["fallback-filter"])
      : {};
  const required = new Set<string>();
  if (geoText.includes("GEOIP") || ("fallback" in dns && filter.geoip !== false))
    required.add(config["geodata-mode"] === true ? "geoip.dat" : "country.mmdb");
  if (geoText.includes("GEOSITE")) required.add("geosite.dat");
  if (geoText.includes("IP-ASN")) required.add("ASN.mmdb");
  const geoDeadline = now() + 90_000;
  let metadata: Awaited<ReturnType<typeof listReleaseAssets>> | undefined;
  for (const name of ["geoip.dat", "geosite.dat", "country.mmdb", "ASN.mmdb"]) {
    try {
      add(name, await readAsset(layout.root, name, GEO_LIMIT));
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!required.has(name)) continue;
    const cache = path.join(layout.root, "service-assets");
    try {
      add(name, await readAsset(cache, name, GEO_LIMIT));
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let staging: string | undefined;
    try {
      // No recursive mkdir through unchecked ancestors. The cache is not Core's data dir.
      assertCacheDirectory(layout.root);
      if (!fs.existsSync(cache)) fs.mkdirSync(cache, { mode: 0o700 });
      assertCacheDirectory(cache);
      metadata ??= await (options.listReleaseAssets ?? listReleaseAssets)(
        "MetaCubeX/meta-rules-dat",
        "latest",
      );
      const releaseName = name === "ASN.mmdb" ? "GeoLite2-ASN.mmdb" : name;
      const asset = metadata.find((asset) => asset.name === releaseName);
      if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > GEO_LIMIT)
        throw new Error("Missing bounded official metadata");
      const digest = parseSha256Digest(asset.digest);
      const remaining = geoDeadline - now();
      if (remaining <= 0) throw new Error("Geodata deadline exceeded");
      assertCacheDirectory(cache);
      staging = fs.mkdtempSync(path.join(cache, "download-"));
      if (process.platform !== "win32") fs.chmodSync(staging, 0o700);
      await (options.downloadReleaseAsset ?? downloadReleaseAsset)({
        repo: "MetaCubeX/meta-rules-dat",
        tag: "latest",
        assets: [asset],
        candidates: [releaseName],
        dest: path.join(staging, name),
        deadlineMs: remaining,
      });
      if (process.platform !== "win32") fs.chmodSync(path.join(staging, name), 0o600);
      const data = await readAsset(staging, name, GEO_LIMIT);
      if (
        now() >= geoDeadline ||
        data.length !== asset.size ||
        createHash("sha256").update(data).digest("hex") !== digest
      )
        throw new Error("Geodata integrity or deadline failure");
      assertCacheDirectory(cache);
      // Reject an existing link even though atomic rename itself would not follow it.
      if (fs.existsSync(path.join(cache, name))) await readAsset(cache, name, GEO_LIMIT);
      atomicWriteFileSync(path.join(cache, name), data, 0o600);
      add(name, data);
    } catch {
      throw new Error(
        `Trusted service geodata ${name} unavailable: require bounded official SHA-256 metadata and verified MetaCubeX/meta-rules-dat@latest bytes; no alternate profile download is permitted`,
      );
    } finally {
      if (staging) {
        assertCacheDirectory(cache);
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }
  }
  config["geo-auto-update"] = false;
  const configSize = Buffer.byteLength(JSON.stringify(config));
  if (
    configSize > PROVIDER_LIMIT ||
    configSize + assets.reduce((sum, asset) => sum + Buffer.byteLength(asset.data, "base64"), 0) >
      TOTAL_LIMIT
  )
    throw new Error("Service bundle config or decoded total exceeds limit");
  const bundle: ServiceBundle = { config, assets };
  if (refreshMs !== undefined)
    Object.defineProperty(bundle, "refreshMs", { value: refreshMs, enumerable: false });
  return bundle;
}
