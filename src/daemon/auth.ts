import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function secretsEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "[::1]";
}

export function isLoopbackHostHeader(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return isLoopbackHostname(new URL(`http://${value}`).hostname);
  } catch {
    return false;
  }
}

export function isLoopbackOriginHeader(value: string | undefined): boolean {
  // Same-origin browser GETs and non-browser CLI clients do not send an Origin
  // header, so a missing Origin passes this boundary; control routes still
  // require the CLI bearer or a same-origin dashboard request.
  if (!value) return true;
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function isControlMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/**
 * The dashboard is trusted by where it is served from, not by a credential: any
 * page loaded from this Sash's own origin may control it. Browsers stamp every
 * request with provenance a page cannot forge — Origin on state-changing
 * requests and WebSocket handshakes, Sec-Fetch-Site on the rest — so pages on
 * other sites, and on other loopback ports, are refused. Local processes can
 * send either header; they are inside the trust boundary.
 */
export function isSameOriginBrowserRequest(req: IncomingMessage): boolean {
  const host = firstHeader(req.headers.host);
  if (!isLoopbackHostHeader(host)) return false;
  const origin = firstHeader(req.headers.origin);
  if (origin) {
    try {
      const url = new URL(origin);
      return url.protocol === "http:" && url.host === new URL(`http://${host}`).host;
    } catch {
      return false;
    }
  }
  return firstHeader(req.headers["sec-fetch-site"]).trim().toLowerCase() === "same-origin";
}

/** An explicit bearer must be the daemon secret; without one, only the dashboard's own origin is admitted. */
export function isControlRequestAuthorized(req: IncomingMessage, daemonSecret: string): boolean {
  const authorization = firstHeader(req.headers.authorization);
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (bearer) return Boolean(daemonSecret) && secretsEqual(bearer, daemonSecret);
  return isSameOriginBrowserRequest(req);
}
