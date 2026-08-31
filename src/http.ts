import fs from "node:fs";
import path from "node:path";
import type { Dispatcher } from "undici";
import { Agent, EnvHttpProxyAgent, interceptors, request } from "undici";

/**
 * HTTP helpers built on undici.
 *
 * - Remote requests honour HTTP_PROXY / HTTPS_PROXY / NO_PROXY / ALL_PROXY via
 *   EnvHttpProxyAgent (essential because Sash's users often sit behind the very
 *   proxy Sash manages).
 * - Loopback requests (mihomo external-controller) use a direct Agent so the
 *   local API is never hijacked by a proxy env var.
 * - Redirect following is opt-in via the redirect interceptor; plain requests
 *   return 3xx as-is so callers can inspect Location headers.
 */

export const USER_AGENT = "sash-cli (https://github.com/ming-kang/Sash)";

let baseProxyDispatcher: Dispatcher | undefined;
let redirectProxyDispatcher: Dispatcher | undefined;
let baseDirectDispatcher: Dispatcher | undefined;
let redirectDirectDispatcher: Dispatcher | undefined;

function getBaseProxyDispatcher(): Dispatcher {
  if (!baseProxyDispatcher) {
    // EnvHttpProxyAgent covers HTTP_PROXY/HTTPS_PROXY/NO_PROXY; ALL_PROXY is a
    // common extra convention among proxy tools, so fold it in via constructor
    // options without ever mutating process.env.
    const allProxyRaw = process.env.ALL_PROXY ?? process.env.all_proxy;
    const allProxy = allProxyRaw && /^https?:\/\//i.test(allProxyRaw) ? allProxyRaw : undefined;
    const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy ?? allProxy;
    const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? allProxy;
    baseProxyDispatcher = new EnvHttpProxyAgent({
      ...(httpProxy ? { httpProxy } : {}),
      ...(httpsProxy ? { httpsProxy } : {}),
    });
  }
  return baseProxyDispatcher;
}

function getBaseDirectDispatcher(): Dispatcher {
  if (!baseDirectDispatcher) {
    baseDirectDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return baseDirectDispatcher;
}

/** Public accessor for the shared proxy-aware dispatcher (remote requests). */
export function proxyAwareDispatcher(): Dispatcher {
  return getBaseProxyDispatcher();
}

/** Public accessor for the shared direct dispatcher (loopback requests). */
export function directDispatcherForLoopback(): Dispatcher {
  return getBaseDirectDispatcher();
}

function pickDispatcher(opts: { direct?: boolean; manualRedirect?: boolean }): Dispatcher {
  const base = opts.direct ? getBaseDirectDispatcher() : getBaseProxyDispatcher();
  if (opts.manualRedirect) return base;
  if (opts.direct) {
    if (!redirectDirectDispatcher) {
      redirectDirectDispatcher = base.compose(interceptors.redirect({ maxRedirections: 5 }));
    }
    return redirectDirectDispatcher;
  }
  if (!redirectProxyDispatcher) {
    redirectProxyDispatcher = base.compose(interceptors.redirect({ maxRedirections: 5 }));
  }
  return redirectProxyDispatcher;
}

export interface FetchResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  text: () => Promise<string>;
  buffer: () => Promise<Buffer>;
}

export interface FetchOptions {
  /** Total attempts including the first try. Default 4. */
  attempts?: number;
  /** Per-attempt headers timeout (ms). Default 30_000. */
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Use the direct (non-proxy) dispatcher. For loopback API calls. */
  direct?: boolean;
  method?: string;
  body?: string | Buffer;
  /** Do not follow redirects; expose status/location to the caller. */
  manualRedirect?: boolean;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<FetchResponse> {
  const attempts = opts.attempts ?? 4;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await request(url, {
        method: (opts.method ?? "GET") as Dispatcher.HttpMethod,
        headers: { "user-agent": USER_AGENT, ...opts.headers },
        body: opts.body,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        dispatcher: pickDispatcher(opts),
      });
      if (RETRYABLE_STATUS.has(res.statusCode) && attempt < attempts) {
        await res.body.dump();
        throw new Error(`HTTP ${res.statusCode}`);
      }
      const body = res.body;
      return {
        statusCode: res.statusCode,
        headers: res.headers as Record<string, string | string[] | undefined>,
        text: () => body.text(),
        buffer: async () => Buffer.from(await body.arrayBuffer()),
      };
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        await sleep(Math.min(4_000, 300 * 2 ** (attempt - 1)) + Math.random() * 200);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export type DownloadProgress = (downloaded: number, total: number | undefined) => void;

export interface DownloadOptions {
  stallMs?: number;
  onProgress?: DownloadProgress;
  headers?: Record<string, string>;
  /**
   * When provided, redirects are followed manually hop-by-hop and every
   * redirect target host must be in this set; otherwise redirects are
   * followed automatically by undici's redirect interceptor.
   */
  allowedHosts?: ReadonlySet<string>;
}

function validateRedirectTarget(
  location: string,
  currentUrl: string,
  allowedHosts: ReadonlySet<string>,
): string {
  const target = new URL(location, currentUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Refusing redirect to non-http(s) URL: ${target.href}`);
  }
  if (!allowedHosts.has(target.hostname.toLowerCase())) {
    throw new Error(`Refusing redirect to untrusted host: ${target.hostname}`);
  }
  return target.href;
}

/**
 * Download a URL to a file with stall detection. Throws on non-2xx or when no
 * bytes arrive for `stallMs`. Partial files are removed on failure.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: DownloadOptions = {},
): Promise<number> {
  const stallMs = opts.stallMs ?? 60_000;
  const maxRedirects = 5;

  let currentUrl = url;
  let res: Awaited<ReturnType<typeof request>>;
  if (opts.allowedHosts) {
    const dispatcher = pickDispatcher({ direct: false, manualRedirect: true });
    let hops = 0;
    for (;;) {
      res = await request(currentUrl, {
        method: "GET",
        headers: { "user-agent": USER_AGENT, ...opts.headers },
        headersTimeout: 30_000,
        bodyTimeout: stallMs,
        dispatcher,
      });
      const isRedirect =
        res.statusCode >= 300 && res.statusCode < 400 && Boolean(res.headers.location);
      if (!isRedirect) break;
      const locationHeader = res.headers.location;
      const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
      await res.body.dump();
      if (!location) throw new Error(`Redirect without Location header from ${currentUrl}`);
      hops += 1;
      if (hops > maxRedirects) {
        throw new Error(`Too many redirects (>${maxRedirects}) downloading ${url}`);
      }
      currentUrl = validateRedirectTarget(location, currentUrl, opts.allowedHosts);
    }
  } else {
    res = await request(currentUrl, {
      method: "GET",
      headers: { "user-agent": USER_AGENT, ...opts.headers },
      headersTimeout: 30_000,
      bodyTimeout: stallMs,
      dispatcher: pickDispatcher({ direct: false, manualRedirect: false }),
    });
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    await res.body.dump();
    throw new Error(`HTTP ${res.statusCode} for ${currentUrl}`);
  }
  const totalHeader = res.headers["content-length"];
  const parsedTotal =
    typeof totalHeader === "string" ? Number.parseInt(totalHeader, 10) : Number.NaN;
  const total = Number.isFinite(parsedTotal) ? parsedTotal : undefined;

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest, { mode: 0o755 });
  let downloaded = 0;
  let success = false;
  try {
    for await (const chunk of res.body) {
      out.write(chunk);
      downloaded += (chunk as Buffer).length;
      opts.onProgress?.(downloaded, total);
    }
    if (downloaded === 0) throw new Error(`Empty download from ${currentUrl}`);
    success = true;
    return downloaded;
  } finally {
    await new Promise<void>((resolve) => out.close(() => resolve()));
    if (!success) fs.rmSync(dest, { force: true });
  }
}
