import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Dispatcher, request } from "undici";
import {
  directDispatcherForLoopback,
  extractConnectRefusedEndpoint,
  formatProxyFallbackFailure,
  formatProxyRefusedError,
  isLoopbackHost,
  isProxyConnectionRefused,
  type ProxyFallbackListener,
  positiveTimeout,
  proxyAwareDispatcher,
  USER_AGENT,
} from "./http.js";

/**
 * Streamed file downloads with stall/deadline detection, redirect allowlists,
 * size caps, and optional SHA-256 verification of the bytes as they arrive.
 */

export type DownloadProgress = (downloaded: number, total: number | undefined) => void;

type UndiciResponseBody = Awaited<ReturnType<typeof request>>["body"];

function abortResponseBody(body: UndiciResponseBody): void {
  body.on("error", () => undefined);
  body.destroy();
}

export interface DownloadOptions {
  signal?: AbortSignal;
  stallMs?: number;
  /** Absolute budget across redirects, headers, and the complete body. Default 15 minutes. */
  deadlineMs?: number;
  maxBytes?: number;
  onProgress?: DownloadProgress;
  headers?: Record<string, string>;
  requireHttps?: boolean;
  /** Every initial and redirected download host must be in this set. */
  allowedHosts: ReadonlySet<string>;
  /** Expected SHA-256 digest of the bytes, checked as they stream. */
  integrity?: string;
  /**
   * When set, a loopback proxy refusal warns through this listener and the
   * download retries once without the proxy. Omit it for URLs that must
   * never leave the machine unproxied.
   */
  onProxyFallback?: ProxyFallbackListener;
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
 * Download a URL to a file with stall and absolute-deadline detection. Throws
 * on non-2xx, when no bytes arrive for stallMs, or when the total redirect/body
 * budget expires. Partial files are removed on failure.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: DownloadOptions,
): Promise<number> {
  const stallMs = positiveTimeout(opts.stallMs, 60_000, "stallMs");
  const deadlineMs = positiveTimeout(opts.deadlineMs, 15 * 60_000, "deadlineMs");
  const maxRedirects = 5;
  const deadline = new AbortController();
  const signal = opts.signal ? AbortSignal.any([deadline.signal, opts.signal]) : deadline.signal;
  const deadlineTimer = setTimeout(() => {
    deadline.abort(new Error(`Download deadline exceeded after ${deadlineMs}ms`));
  }, deadlineMs);
  let outputStarted = false;

  const attempt = async (dispatcher: Dispatcher): Promise<number> => {
    let res: Awaited<ReturnType<typeof request>> | undefined;
    try {
      const integrity = opts.integrity;
      const hash = integrity ? crypto.createHash("sha256") : undefined;
      let currentUrl = validateRedirectTarget(url, url, opts.allowedHosts, opts.requireHttps);
      let hops = 0;
      for (;;) {
        res = await request(currentUrl, {
          method: "GET",
          headers: { "user-agent": USER_AGENT, ...opts.headers },
          headersTimeout: 30_000,
          bodyTimeout: stallMs,
          signal,
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
        currentUrl = validateRedirectTarget(
          location,
          currentUrl,
          opts.allowedHosts,
          opts.requireHttps,
        );
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
        abortResponseBody(res.body);
        throw new Error(`Invalid download size limit: ${maxBytes}`);
      }
      if (maxBytes !== undefined && total !== undefined && total > maxBytes) {
        abortResponseBody(res.body);
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
          hash?.update(chunk);
          callback(null, chunk);
        },
      });

      outputStarted = true;
      await pipeline(res.body, limiter, fs.createWriteStream(dest, { mode: 0o600 }));
      if (downloaded === 0) throw new Error(`Empty download from ${currentUrl}`);
      if (integrity && hash?.digest("hex") !== integrity)
        throw new Error("SHA-256 mismatch for downloaded artifact");
      return downloaded;
    } catch (err) {
      if (res) abortResponseBody(res.body);
      if (outputStarted) fs.rmSync(dest, { force: true });
      throw err;
    }
  };

  try {
    return await attempt(proxyAwareDispatcher());
  } catch (err) {
    if (isProxyConnectionRefused(err, url)) {
      const endpoint = extractConnectRefusedEndpoint(err);
      if (opts.onProxyFallback && endpoint && isLoopbackHost(endpoint.address)) {
        opts.onProxyFallback({ proxy: endpoint, url });
        try {
          return await attempt(directDispatcherForLoopback());
        } catch (directError) {
          signal.throwIfAborted();
          throw formatProxyFallbackFailure(endpoint, directError);
        }
      }
      throw formatProxyRefusedError(err);
    }
    throw err;
  } finally {
    clearTimeout(deadlineTimer);
  }
}
