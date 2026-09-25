import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import { WEB_SOCKET_AUTH_PROTOCOL, WEB_SOCKET_TOKEN_PROTOCOL_PREFIX } from "../contracts.js";
import { atomicWriteFileSync } from "../fs-atomic.js";
import { isPlainObject } from "../json-shape.js";

export const WEB_BOOTSTRAP_TTL_MS = 90_000;
const MAX_PENDING_BOOTSTRAPS = 32;
const MAX_SESSIONS = 256;
const WEB_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_FILE_LIMIT = 256 * 1024;

interface WebSessionSeed {
  hash: string;
  expiresAt: number;
}

function parseWebSessionSeeds(value: unknown): WebSessionSeed[] {
  const seeds = (value as { seeds?: unknown })?.seeds;
  if (!Array.isArray(seeds) || seeds.length > MAX_SESSIONS * 2) return [];
  return seeds.flatMap((seed: unknown): WebSessionSeed[] => {
    const record = seed as Record<string, unknown> | null;
    if (
      !isPlainObject(record) ||
      typeof record.hash !== "string" ||
      typeof record.expiresAt !== "number" ||
      !Number.isSafeInteger(record.expiresAt)
    )
      return [];
    return [{ hash: record.hash, expiresAt: record.expiresAt }];
  });
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** In-memory credentials; session hashes persist only to survive a daemon restart. */
export class WebAuthManager {
  private readonly pendingBootstraps = new Map<string, number>();
  private readonly sessions = new Map<string, number>();

  constructor(private readonly sessionsFile?: string) {
    if (!sessionsFile) return;
    try {
      const text = fs.readFileSync(sessionsFile, "utf8");
      if (text.length > SESSION_FILE_LIMIT) return;
      const now = Date.now();
      for (const seed of parseWebSessionSeeds(JSON.parse(text) as unknown)) {
        if (seed.expiresAt > now) this.setSession(seed.hash, seed.expiresAt);
      }
    } catch {}
  }

  private persist(now = Date.now()): void {
    if (!this.sessionsFile) return;
    this.sweepExpired(now);
    if (!this.sessions.size) return;
    const seeds: WebSessionSeed[] = Array.from(this.sessions, ([hash, expiresAt]) => ({
      hash,
      expiresAt,
    }));
    try {
      atomicWriteFileSync(this.sessionsFile, `${JSON.stringify({ seeds })}\n`, 0o600);
    } catch {}
  }

  createBootstrap(now = Date.now()): { token: string; expiresAt: string } {
    this.sweepExpired(now);
    while (this.pendingBootstraps.size >= MAX_PENDING_BOOTSTRAPS) {
      const oldest = this.pendingBootstraps.keys().next().value;
      if (oldest === undefined) break;
      this.pendingBootstraps.delete(oldest);
    }
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAtMs = now + WEB_BOOTSTRAP_TTL_MS;
    this.pendingBootstraps.set(hashToken(token), expiresAtMs);
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  redeemBootstrap(token: string, now = Date.now()): string | null {
    this.sweepExpired(now);
    if (!token) return null;
    const key = hashToken(token);
    const expiresAt = this.pendingBootstraps.get(key);
    if (expiresAt === undefined || expiresAt <= now) return null;
    this.pendingBootstraps.delete(key);
    const session = crypto.randomBytes(32).toString("hex");
    this.adoptSession(session, now);
    return session;
  }

  isSession(token: string, now = Date.now()): boolean {
    this.sweepExpired(now);
    if (!token || !this.sessions.has(hashToken(token))) return false;
    this.adoptSession(token, now);
    return true;
  }

  private setSession(hash: string, expiresAt: number): void {
    this.sessions.delete(hash);
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    this.sessions.set(hash, expiresAt);
  }

  private adoptSession(token: string, now: number): void {
    const hash = hashToken(token);
    const stored = this.sessions.get(hash);
    const expiresAt = now + WEB_SESSION_TTL_MS;
    this.setSession(hash, expiresAt);
    if (stored === undefined || expiresAt - stored > WEB_SESSION_TTL_MS / 2) this.persist(now);
  }

  private sweepExpired(now: number): void {
    for (const [key, expiresAt] of this.pendingBootstraps) {
      if (expiresAt <= now) this.pendingBootstraps.delete(key);
    }
    for (const [key, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(key);
    }
  }
}

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

export interface ControlAuthorization {
  daemonSecret: string;
  /** Validates an in-memory WebUI session token issued via bootstrap exchange. */
  isSessionToken: (token: string) => boolean;
}

/** The per-boot health token is an identity nonce only and never authorizes. */
export function isControlRequestAuthorized(
  req: IncomingMessage,
  opts: ControlAuthorization,
): boolean {
  const authorization = firstHeader(req.headers.authorization);
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (bearer && opts.daemonSecret && secretsEqual(bearer, opts.daemonSecret)) return true;

  const webToken = firstHeader(req.headers["x-sash-token"]).trim();
  return Boolean(webToken && opts.isSessionToken(webToken));
}

function webSocketProtocols(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value.join(",") : (value ?? ""))
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

export function isWebSocketRequestAuthorized(
  req: IncomingMessage,
  opts: ControlAuthorization,
): boolean {
  if (isControlRequestAuthorized(req, opts)) return true;
  return webSocketProtocols(req.headers["sec-websocket-protocol"]).some((protocol) => {
    if (!protocol.startsWith(WEB_SOCKET_TOKEN_PROTOCOL_PREFIX)) return false;
    const token = protocol.slice(WEB_SOCKET_TOKEN_PROTOCOL_PREFIX.length);
    return opts.isSessionToken(token);
  });
}

export function webSocketAuthResponseProtocol(
  value: string | string[] | undefined,
): string | undefined {
  const protocols = webSocketProtocols(value);
  return (
    protocols.find((protocol) => protocol === WEB_SOCKET_AUTH_PROTOCOL) ??
    protocols.find((protocol) => protocol.startsWith(WEB_SOCKET_TOKEN_PROTOCOL_PREFIX))
  );
}

export function coreWebSocketProtocols(value: string | string[] | undefined): string | undefined {
  const protocols = webSocketProtocols(value).filter(
    (protocol) =>
      protocol !== WEB_SOCKET_AUTH_PROTOCOL &&
      !protocol.startsWith(WEB_SOCKET_TOKEN_PROTOCOL_PREFIX),
  );
  return protocols.length > 0 ? protocols.join(", ") : undefined;
}
