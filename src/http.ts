import type { Dispatcher } from "undici";
import { Agent, EnvHttpProxyAgent, request } from "undici";

/**
 * HTTP helpers built on undici.
 *
 * Remote requests honour HTTP_PROXY / HTTPS_PROXY / NO_PROXY / ALL_PROXY.
 * Loopback external-controller requests use a direct Agent so proxy environment
 * variables cannot intercept them. Redirects are never followed implicitly:
 * every caller receives 3xx responses and handles each hop itself.
 */

export const USER_AGENT = "sash-cli (https://github.com/ming-kang/Sash)";
export const ERROR_BODY_LIMIT = 32 * 1024;

let baseProxyDispatcher: Dispatcher | undefined;
let baseDirectDispatcher: Dispatcher | undefined;

function getBaseProxyDispatcher(): Dispatcher {
  if (!baseProxyDispatcher) {
    // EnvHttpProxyAgent covers HTTP_PROXY/HTTPS_PROXY/NO_PROXY; ALL_PROXY is a
    // common extra convention, folded into options without changing process.env.
    const allProxyRaw = process.env.ALL_PROXY ?? process.env.all_proxy;
    let allProxy: string | undefined;
    if (allProxyRaw && /^https?:\/\//i.test(allProxyRaw)) {
      allProxy = allProxyRaw;
    } else if (allProxyRaw) {
      // Warned once per process: the dispatcher below is cached.
      console.warn("[sash] ignoring ALL_PROXY — only http:// or https:// proxies are supported");
    }
    const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy ?? allProxy;
    const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? allProxy;
    // allowH2: false keeps the pre-undici-8 HTTP/1.1 wire behavior; the
    // download path's stall-timeout and size-cap invariants are tested on h1.
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

/** Public accessor for the shared proxy-aware dispatcher (remote requests). */
export function proxyAwareDispatcher(): Dispatcher {
  return getBaseProxyDispatcher();
}

/** Public accessor for the shared direct dispatcher (loopback requests). */
export function directDispatcherForLoopback(): Dispatcher {
  return getBaseDirectDispatcher();
}

function pickDispatcher(opts: { direct?: boolean }): Dispatcher {
  return opts.direct ? getBaseDirectDispatcher() : getBaseProxyDispatcher();
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

/**
 * Invoked when a loopback proxy refusal sends the request down a direct
 * retry. Callers decide how the warning reaches the user.
 */
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

/**
 * Decide whether an exhausted request may retry without the proxy. Only a
 * loopback refusal qualifies: the dead endpoint is a local tool (often Sash
 * itself), so direct access matches the caller's intent. A dead remote proxy
 * means the user's upstream is down and silently bypassing it would surprise.
 */
function loopbackRefusalOf(error: unknown): ConnectRefusedEndpoint | undefined {
  const endpoint = extractConnectRefusedEndpoint(error);
  return endpoint && isLoopbackHost(endpoint.address) ? endpoint : undefined;
}

export interface FetchResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  /** Consume the body as UTF-8, rejecting it if it exceeds maxBytes. */
  text: (maxBytes: number) => Promise<string>;
  /** Drain the body without buffering it. */
  discard: () => Promise<void>;
}

/** Best-effort diagnostics must never replace an already known HTTP failure. */
export async function readErrorSummary(response: FetchResponse): Promise<string> {
  try {
    return (await response.text(ERROR_BODY_LIMIT)).slice(0, 200).trim();
  } catch {
    return "";
  }
}

export interface FetchOptions {
  signal?: AbortSignal;
  /** Total attempts including the first. The default is method-aware. */
  attempts?: number;
  /** Per-attempt time to receive response headers. Default 30 seconds. */
  headersTimeoutMs?: number;
  /** Absolute request budget, including retries, headers, and body consumption. Default 60 seconds. */
  deadlineMs?: number;
  headers?: Record<string, string>;
  /** Use the direct (non-proxy) dispatcher. Reserved for loopback API calls. */
  direct?: boolean;
  /**
   * When set, a loopback proxy refusal warns through this listener and the
   * request retries once without the proxy. Omit it for URLs that must never
   * leave the machine unproxied (for example user-supplied subscriptions).
   */
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
  const deadlineMs = positiveTimeout(opts.deadlineMs, 60_000, "deadlineMs");
  const deadline = new AbortController();
  const signal = opts.signal ? AbortSignal.any([deadline.signal, opts.signal]) : deadline.signal;
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
    if (!opts.direct && isProxyConnectionRefused(lastErr, url)) {
      const loopback = loopbackRefusalOf(lastErr);
      if (opts.onProxyFallback && loopback) {
        opts.onProxyFallback({ proxy: loopback, url });
        try {
          // direct: true disables this branch in the recursive call.
          return await fetchWithRetry(url, { ...opts, direct: true });
        } catch (directError) {
          signal.throwIfAborted();
          throw formatProxyFallbackFailure(loopback, directError);
        }
      }
      throw formatProxyRefusedError(lastErr);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } finally {
    // Once a response is returned, its ownership methods clear this timer.
    // Failed attempts and exhausted retries must clear it here.
    if (!responseReturned) clearDeadline();
  }
}
