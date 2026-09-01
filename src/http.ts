import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Dispatcher } from "undici";
import { Agent, EnvHttpProxyAgent, interceptors, request } from "undici";

/**
 * HTTP helpers built on undici.
 *
 * Remote requests honour HTTP_PROXY / HTTPS_PROXY / NO_PROXY / ALL_PROXY.
 * Loopback external-controller requests use a direct Agent so proxy environment
 * variables cannot intercept them. Redirect following is opt-in; callers which
 * need redirect policy receive 3xx responses and handle every hop themselves.
 */

export const USER_AGENT = "sash-cli (https://github.com/ming-kang/Sash)";
export const ERROR_BODY_LIMIT = 32 * 1024;

let baseProxyDispatcher: Dispatcher | undefined;
let redirectProxyDispatcher: Dispatcher | undefined;
let baseDirectDispatcher: Dispatcher | undefined;
let redirectDirectDispatcher: Dispatcher | undefined;

function getBaseProxyDispatcher(): Dispatcher {
  if (!baseProxyDispatcher) {
    // EnvHttpProxyAgent covers HTTP_PROXY/HTTPS_PROXY/NO_PROXY; ALL_PROXY is a
    // common extra convention, folded into options without changing process.env.
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
  if (!baseDirectDispatcher) baseDirectDispatcher = new Agent();
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
  /** Consume the body as UTF-8, rejecting it if it exceeds maxBytes. */
  text: (maxBytes: number) => Promise<string>;
  /** Consume the body, rejecting it if it exceeds maxBytes. */
  buffer: (maxBytes: number) => Promise<Buffer>;
  /** Drain the body without buffering it. */
  discard: () => Promise<void>;
}

export interface FetchOptions {
  /** Total attempts including the first. The default is method-aware. */
  attempts?: number;
  /** Per-attempt time to receive response headers. Default 30 seconds. */
  headersTimeoutMs?: number;
  /** Maximum inactivity between response-body chunks. Default 30 seconds. */
  bodyInactivityTimeoutMs?: number;
  /** Absolute request budget, including retries, headers, and body consumption. Default 60 seconds. */
  deadlineMs?: number;
  headers?: Record<string, string>;
  /** Use the direct (non-proxy) dispatcher. Reserved for loopback API calls. */
  direct?: boolean;
  method?: string;
  body?: string | Buffer;
  /** Do not follow redirects; expose status/location to the caller. */
  manualRedirect?: boolean;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_METHODS = new Set(["GET", "HEAD"]);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("HTTP request aborted"),
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("HTTP request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function defaultAttempts(method: string): number {
  return RETRYABLE_METHODS.has(method.toUpperCase()) ? 4 : 1;
}

/**
 * Fetch a non-download response with method-aware retries and an absolute
 * deadline. The deadline remains active until the returned body is consumed or
 * discarded, so a peer cannot evade it by slowly dripping body bytes.
 */
export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<FetchResponse> {
  const method = (opts.method ?? "GET").toUpperCase();
  const attempts = opts.attempts ?? defaultAttempts(method);
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer");
  }
  const headersTimeoutMs = positiveTimeout(opts.headersTimeoutMs, 30_000, "headersTimeoutMs");
  const bodyInactivityTimeoutMs = positiveTimeout(
    opts.bodyInactivityTimeoutMs,
    30_000,
    "bodyInactivityTimeoutMs",
  );
  const deadlineMs = positiveTimeout(opts.deadlineMs, 60_000, "deadlineMs");
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => {
    deadline.abort(new Error(`HTTP request deadline exceeded after ${deadlineMs}ms`));
  }, deadlineMs);
  let settled = false;
  let responseReturned = false;
  const clearDeadline = (): void => {
    if (!settled) {
      settled = true;
      clearTimeout(deadlineTimer);
    }
  };
  let lastErr: unknown;

  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await request(url, {
          method: method as Dispatcher.HttpMethod,
          headers: { "user-agent": USER_AGENT, ...opts.headers },
          body: opts.body,
          headersTimeout: headersTimeoutMs,
          bodyTimeout: bodyInactivityTimeoutMs,
          signal: deadline.signal,
          dispatcher: pickDispatcher(opts),
        });
        if (RETRYABLE_STATUS.has(res.statusCode) && attempt < attempts) {
          await res.body.dump();
          throw new Error(`HTTP ${res.statusCode}`);
        }

        const body = res.body;
        let claimed = false;
        const claimBody = (): void => {
          if (claimed) throw new Error("Response body has already been consumed or discarded");
          claimed = true;
        };
        const consume = async (maxBytes: number): Promise<Buffer> => {
          claimBody();
          if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
            body.destroy();
            clearDeadline();
            throw new Error("maxBytes must be a non-negative safe integer");
          }
          const chunks: Buffer[] = [];
          let total = 0;
          try {
            for await (const chunk of body) {
              const data = Buffer.from(chunk);
              total += data.length;
              if (total > maxBytes) {
                body.destroy();
                throw new Error(`Response body exceeds ${maxBytes} byte limit`);
              }
              chunks.push(data);
            }
            return Buffer.concat(chunks, total);
          } finally {
            clearDeadline();
          }
        };
        responseReturned = true;
        return {
          statusCode: res.statusCode,
          headers: res.headers as Record<string, string | string[] | undefined>,
          text: async (maxBytes) => (await consume(maxBytes)).toString("utf8"),
          buffer: consume,
          discard: async () => {
            claimBody();
            try {
              await body.dump();
            } finally {
              clearDeadline();
            }
          },
        };
      } catch (err) {
        lastErr = err;
        if (deadline.signal.aborted || attempt === attempts) break;
        await sleep(
          Math.min(4_000, 300 * 2 ** (attempt - 1)) + Math.random() * 200,
          deadline.signal,
        );
        if (deadline.signal.aborted) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } finally {
    // Once a response is returned, its ownership methods clear this timer.
    // Failed attempts and exhausted retries must clear it here.
    if (!responseReturned) clearDeadline();
  }
}

export type DownloadProgress = (downloaded: number, total: number | undefined) => void;

export interface DownloadOptions {
  stallMs?: number;
  maxBytes?: number;
  onProgress?: DownloadProgress;
  headers?: Record<string, string>;
  requireHttps?: boolean;
  /** Every initial and redirected download host must be in this set. */
  allowedHosts: ReadonlySet<string>;
}

function validateRedirectTarget(
  location: string,
  currentUrl: string,
  allowedHosts: ReadonlySet<string>,
  requireHttps = false,
): string {
  const target = new URL(location, currentUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Refusing redirect to non-http(s) URL: ${target.href}`);
  }
  if (requireHttps && target.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS download URL: ${target.href}`);
  }
  if (!allowedHosts.has(target.hostname.toLowerCase())) {
    throw new Error(`Refusing redirect to untrusted host: ${target.hostname}`);
  }
  return target.href;
}

/**
 * Download a URL to a file with stall detection. Throws on non-2xx or when no
 * bytes arrive for stallMs. Partial files are removed on failure.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: DownloadOptions,
): Promise<number> {
  const stallMs = opts.stallMs ?? 60_000;
  const maxRedirects = 5;

  let currentUrl = validateRedirectTarget(url, url, opts.allowedHosts, opts.requireHttps);
  let res: Awaited<ReturnType<typeof request>>;
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
    currentUrl = validateRedirectTarget(location, currentUrl, opts.allowedHosts, opts.requireHttps);
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    await res.body.dump();
    throw new Error(`HTTP ${res.statusCode} for ${currentUrl}`);
  }
  const totalHeader = res.headers["content-length"];
  const parsedTotal =
    typeof totalHeader === "string" ? Number.parseInt(totalHeader, 10) : Number.NaN;
  const total = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : undefined;
  const maxBytes = opts.maxBytes;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    res.body.destroy();
    throw new Error(`Invalid download size limit: ${maxBytes}`);
  }
  if (maxBytes !== undefined && total !== undefined && total > maxBytes) {
    res.body.destroy();
    throw new Error(`Download exceeds ${maxBytes} byte safety limit: ${currentUrl}`);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let downloaded = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloaded += chunk.length;
      if (maxBytes !== undefined && downloaded > maxBytes) {
        callback(new Error(`Download exceeds ${maxBytes} byte safety limit: ${currentUrl}`));
        return;
      }
      opts.onProgress?.(downloaded, total);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(res.body, limiter, fs.createWriteStream(dest, { mode: 0o755 }));
    if (downloaded === 0) throw new Error(`Empty download from ${currentUrl}`);
    return downloaded;
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
}
