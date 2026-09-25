import type { Dispatcher } from "undici";
import { Agent, EnvHttpProxyAgent, ProxyAgent, request } from "undici";

/**
 * Remote requests honour the proxy environment. Loopback requests use a direct
 * agent so proxy variables cannot intercept them, and redirects are never
 * followed: callers receive every 3xx.
 */

export const USER_AGENT = "sash-cli (https://github.com/ming-kang/Sash)";
export const ERROR_BODY_LIMIT = 32 * 1024;

let baseProxyDispatcher: Dispatcher | undefined;
let baseDirectDispatcher: Dispatcher | undefined;
const uriProxyDispatchers = new Map<string, Dispatcher>();

function getBaseProxyDispatcher(): Dispatcher {
  if (!baseProxyDispatcher) {
    // undici's EnvHttpProxyAgent ignores ALL_PROXY, so it is folded in here.
    const allProxyRaw = process.env.ALL_PROXY ?? process.env.all_proxy;
    let allProxy: string | undefined;
    if (allProxyRaw && /^https?:\/\//i.test(allProxyRaw)) {
      allProxy = allProxyRaw;
    } else if (allProxyRaw) {
      console.warn("[sash] ignoring ALL_PROXY — only http:// or https:// proxies are supported");
    }
    const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy ?? allProxy;
    const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? allProxy;
    // allowH2: false keeps HTTP/1.1 wire behavior; the download path's
    // stall-timeout and size-cap invariants are tested on h1.
    baseProxyDispatcher = new EnvHttpProxyAgent({
      allowH2: false,
      ...(httpProxy ? { httpProxy } : {}),
      ...(httpsProxy ? { httpsProxy } : {}),
    });
  }
  return baseProxyDispatcher;
}

function getBaseDirectDispatcher(): Dispatcher {
  if (!baseDirectDispatcher) baseDirectDispatcher = new Agent({ allowH2: false });
  return baseDirectDispatcher;
}

export function proxyAwareDispatcher(): Dispatcher {
  return getBaseProxyDispatcher();
}

export function directDispatcherForLoopback(): Dispatcher {
  return getBaseDirectDispatcher();
}

export function proxyDispatcherFor(uri: string): Dispatcher {
  const cached = uriProxyDispatchers.get(uri);
  if (cached) return cached;
  const dispatcher = new ProxyAgent({ uri, allowH2: false });
  uriProxyDispatchers.set(uri, dispatcher);
  return dispatcher;
}

export function envProxyUri(): string | undefined {
  for (const key of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** The proxy a verified GitHub request leaves through; direct and mirror traffic report none. */
export interface DownloadTransport {
  uri: string;
  source: "environment" | "core";
}

function pickDispatcher(opts: { direct?: boolean; proxyUri?: string }): Dispatcher {
  // Loopback traffic never leaves through a proxy, whatever else is set.
  if (opts.direct) return getBaseDirectDispatcher();
  if (opts.proxyUri) return proxyDispatcherFor(opts.proxyUri);
  return getBaseProxyDispatcher();
}

export function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host === "[::1]"
  );
}

export interface ConnectRefusedEndpoint {
  address: string;
  port: number;
}

export function extractConnectRefusedEndpoint(error: unknown): ConnectRefusedEndpoint | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    code?: unknown;
    address?: unknown;
    port?: unknown;
    cause?: unknown;
    message?: unknown;
  };
  if (
    candidate.code === "ECONNREFUSED" &&
    typeof candidate.address === "string" &&
    typeof candidate.port === "number"
  ) {
    return { address: candidate.address, port: candidate.port };
  }
  if (candidate.cause) {
    const fromCause = extractConnectRefusedEndpoint(candidate.cause);
    if (fromCause) return fromCause;
  }
  if (typeof candidate.message === "string") {
    const match = /connect ECONNREFUSED ([^\s:]+):(\d+)/.exec(candidate.message);
    if (match?.[1] && match[2]) return { address: match[1], port: Number(match[2]) };
  }
  return undefined;
}

export function isProxyConnectionRefused(error: unknown, targetUrl: string): boolean {
  const endpoint = extractConnectRefusedEndpoint(error);
  if (!endpoint) return false;
  try {
    const parsed = new URL(targetUrl);
    const targetPort = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    if (endpoint.port !== targetPort) return true;
    if (endpoint.address !== parsed.hostname && !isLoopbackHost(parsed.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

export function formatProxyRefusedError(error: unknown): Error {
  const endpoint = extractConnectRefusedEndpoint(error);
  if (endpoint) {
    const proxyTarget = `${endpoint.address}:${endpoint.port}`;
    const remedy = isLoopbackHost(endpoint.address)
      ? "check whether that proxy is running, or unset HTTP_PROXY"
      : "check HTTP_PROXY";
    return new Error(`proxy ${proxyTarget} refused connection — ${remedy}`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface ProxyRefusedFallback {
  proxy: ConnectRefusedEndpoint;
  url: string;
}

export type ProxyFallbackListener = (info: ProxyRefusedFallback) => void;

export function formatProxyFallbackWarning(info: ProxyRefusedFallback): string {
  return `proxy ${info.proxy.address}:${info.proxy.port} refused connection — retrying without proxy`;
}

export function formatProxyFallbackFailure(
  proxy: ConnectRefusedEndpoint,
  directError: unknown,
): Error {
  const reason = directError instanceof Error ? directError.message : String(directError);
  return new Error(
    `proxy ${proxy.address}:${proxy.port} refused connection · direct request also failed: ${reason} — check HTTP_PROXY or your network connection`,
    { cause: directError },
  );
}

// Only a loopback refusal qualifies; a dead remote proxy is never bypassed silently.
function loopbackRefusalOf(error: unknown): ConnectRefusedEndpoint | undefined {
  const endpoint = extractConnectRefusedEndpoint(error);
  return endpoint && isLoopbackHost(endpoint.address) ? endpoint : undefined;
}

export interface ProxyFallbackContext {
  url: string;
  signal: AbortSignal;
  onProxyFallback?: ProxyFallbackListener;
}

/** Retries a request directly after a loopback proxy refusal, once. User-supplied URLs never opt in. */
export async function retryDirectOnLoopbackRefusal<T>(
  error: unknown,
  context: ProxyFallbackContext,
  directRetry: () => Promise<T>,
): Promise<T> {
  if (!isProxyConnectionRefused(error, context.url)) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  const loopback = loopbackRefusalOf(error);
  if (!context.onProxyFallback || !loopback) throw formatProxyRefusedError(error);
  context.onProxyFallback({ proxy: loopback, url: context.url });
  try {
    return await directRetry();
  } catch (directError) {
    context.signal.throwIfAborted();
    throw formatProxyFallbackFailure(loopback, directError);
  }
}

export interface FetchResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  text: (maxBytes: number) => Promise<string>;
  discard: () => Promise<void>;
}

export async function readErrorSummary(response: FetchResponse): Promise<string> {
  try {
    return (await response.text(ERROR_BODY_LIMIT)).slice(0, 200).trim();
  } catch {
    return "";
  }
}

export interface FetchOptions {
  signal?: AbortSignal;
  attempts?: number;
  headersTimeoutMs?: number;
  deadlineMs?: number;
  headers?: Record<string, string>;
  direct?: boolean;
  proxyUri?: string;
  /** A loopback proxy refusal warns and retries once direct; never set for user-supplied URLs. */
  onProxyFallback?: ProxyFallbackListener;
  method?: string;
  body?: string | Buffer;
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

export function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

/**
 * A request that outlived its budget; it says nothing about the outcome. A Core
 * reload only answers once it has applied, so callers must treat this as unknown.
 */
export class RequestDeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`HTTP request deadline exceeded after ${deadlineMs}ms`);
    this.name = "RequestDeadlineError";
  }
}

export function isRequestDeadlineError(error: unknown): error is RequestDeadlineError {
  return error instanceof RequestDeadlineError;
}

function defaultAttempts(method: string): number {
  return RETRYABLE_METHODS.has(method.toUpperCase()) ? 4 : 1;
}

/** Non-download fetch with method-aware retries; the deadline covers body consumption too. */
export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<FetchResponse> {
  const method = (opts.method ?? "GET").toUpperCase();
  const attempts = opts.attempts ?? defaultAttempts(method);
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer");
  }
  const headersTimeoutMs = positiveTimeout(opts.headersTimeoutMs, 30_000, "headersTimeoutMs");
  const deadlineMs = positiveTimeout(opts.deadlineMs, 60_000, "deadlineMs");
  const deadline = new AbortController();
  const signal = opts.signal ? AbortSignal.any([deadline.signal, opts.signal]) : deadline.signal;
  const deadlineTimer = setTimeout(() => {
    deadline.abort(new RequestDeadlineError(deadlineMs));
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
          bodyTimeout: 30_000,
          signal,
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
        if (signal.aborted || attempt === attempts) break;
        await sleep(Math.min(4_000, 300 * 2 ** (attempt - 1)) + Math.random() * 200, signal);
        if (signal.aborted) break;
      }
    }
    if (!opts.direct) {
      return retryDirectOnLoopbackRefusal(
        lastErr,
        { url, signal, ...(opts.onProxyFallback ? { onProxyFallback: opts.onProxyFallback } : {}) },
        () => fetchWithRetry(url, { ...opts, direct: true }),
      );
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } finally {
    if (!responseReturned) clearDeadline();
  }
}
