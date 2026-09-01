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

export function isLoopbackHostHeader(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function isControlMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/** Accept the persistent CLI bearer or the per-boot same-origin WebUI token. */
export function isControlRequestAuthorized(
  req: IncomingMessage,
  opts: { daemonSecret: string; bootToken: string },
): boolean {
  const authorization = firstHeader(req.headers.authorization);
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (bearer && opts.daemonSecret && secretsEqual(bearer, opts.daemonSecret)) return true;

  const webToken = firstHeader(req.headers["x-sash-token"]).trim();
  return Boolean(webToken && secretsEqual(webToken, opts.bootToken));
}
