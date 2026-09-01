import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WEB_SOCKET_TOKEN_PROTOCOL_PREFIX } from "./contracts.js";

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

/** Browser WebSockets carry the per-boot token as a private subprotocol. */
export function isWebSocketRequestAuthorized(
  req: IncomingMessage,
  opts: { daemonSecret: string; bootToken: string },
): boolean {
  if (isControlRequestAuthorized(req, opts)) return true;
  const protocols = firstHeader(req.headers["sec-websocket-protocol"])
    .split(",")
    .map((value) => value.trim());
  return protocols.some((protocol) => {
    if (!protocol.startsWith(WEB_SOCKET_TOKEN_PROTOCOL_PREFIX)) return false;
    const token = protocol.slice(WEB_SOCKET_TOKEN_PROTOCOL_PREFIX.length);
    return Boolean(token && secretsEqual(token, opts.bootToken));
  });
}

/** Remove only the daemon credential protocol before forwarding to the Core. */
export function coreWebSocketProtocols(value: string | string[] | undefined): string | undefined {
  const protocols = (Array.isArray(value) ? value.join(",") : (value ?? ""))
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(
      (protocol) => protocol.length > 0 && !protocol.startsWith(WEB_SOCKET_TOKEN_PROTOCOL_PREFIX),
    );
  return protocols.length > 0 ? protocols.join(", ") : undefined;
}
