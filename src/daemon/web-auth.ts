import crypto from "node:crypto";
import type { WebContinuationInfo } from "../contracts.js";
import { hasExactOwnKeys, isPlainObject } from "../json-shape.js";

/** One-time browser bootstrap tokens stay valid long enough for `sash web` to
 * write the bootstrap file and for the browser to load it, but no longer. */
export const WEB_BOOTSTRAP_TTL_MS = 90_000;
const MAX_PENDING_BOOTSTRAPS = 32;
const MAX_SESSIONS = 256;
export const WEB_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const WEB_CONTINUATION_TTL_MS = 10 * 60 * 1000;

export interface WebSessionSeed {
  hash: string;
  bootId: string;
  expiresAt: number;
}

export function parseWebSessionSeeds(value: unknown): WebSessionSeed[] {
  if (!Array.isArray(value) || value.length > MAX_SESSIONS * 2)
    throw new Error("Invalid browser session handoff");
  return value.map((seed: unknown) => {
    if (
      !isPlainObject(seed) ||
      !hasExactOwnKeys(seed, ["hash", "bootId", "expiresAt"]) ||
      typeof seed.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(seed.hash) ||
      typeof seed.bootId !== "string" ||
      !/^[a-f0-9]{48}$/.test(seed.bootId) ||
      typeof seed.expiresAt !== "number" ||
      !Number.isSafeInteger(seed.expiresAt) ||
      seed.expiresAt <= 0
    )
      throw new Error("Invalid browser session seed");
    return { hash: seed.hash, bootId: seed.bootId, expiresAt: seed.expiresAt };
  });
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * In-memory WebUI credentials. Bootstrap tokens are single-use and short
 * lived; session tokens expire after inactivity. Ordinary restarts invalidate
 * them. An explicitly reserved upgrade may install a bounded continuation.
 */
export class WebAuthManager {
  /** Hashed bootstrap token -> expiry (ms since epoch), in insertion order. */
  private readonly pendingBootstraps = new Map<string, number>();
  /** Hashed session tokens, in insertion order for bounded eviction. */
  private readonly sessions = new Map<string, number>();
  private continuation:
    | {
        seeds: WebSessionSeed[];
        key: string;
        bootId: string;
        expiresAt: number;
      }
    | undefined;

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

  /** Consume a bootstrap token and issue a session token; null when invalid. */
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

  private adoptSession(token: string, now: number): void {
    const hash = hashToken(token);
    this.sessions.delete(hash);
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    this.sessions.set(hash, now + WEB_SESSION_TTL_MS);
  }

  sessionSeeds(bootId: string, now = Date.now()): WebSessionSeed[] {
    this.sweepExpired(now);
    const existing = this.continuation?.seeds.filter((seed) => seed.expiresAt > now) ?? [];
    return [
      ...existing,
      ...Array.from(this.sessions, ([hash, expiresAt]) => ({ hash, expiresAt, bootId })),
    ].slice(-MAX_SESSIONS * 2);
  }

  installContinuation(
    seeds: WebSessionSeed[],
    key: string,
    bootId: string,
    expiresAt: number,
  ): void {
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !/^[a-f0-9]{48}$/.test(bootId) ||
      !Number.isSafeInteger(expiresAt)
    )
      throw new Error("Invalid browser continuation authority");
    this.continuation = {
      seeds: parseWebSessionSeeds(seeds).map((seed) => ({
        ...seed,
        expiresAt: Math.min(seed.expiresAt, expiresAt),
      })),
      key,
      bootId,
      expiresAt,
    };
  }

  continuationInfo(now = Date.now()): WebContinuationInfo | undefined {
    this.sweepExpired(now);
    if (!this.continuation) return undefined;
    const bootIds = [
      ...new Set(
        this.continuation.seeds.filter((seed) => seed.expiresAt > now).map((seed) => seed.bootId),
      ),
    ];
    return bootIds.length
      ? { bootIds, expiresAt: new Date(this.continuation.expiresAt).toISOString() }
      : undefined;
  }

  isContinuationToken(token: string, now = Date.now()): boolean {
    this.sweepExpired(now);
    const hash = hashToken(token);
    return Boolean(
      token && this.continuation?.seeds.some((seed) => seed.hash === hash && seed.expiresAt > now),
    );
  }

  redeemContinuation(token: string, sourceBootId: string, now = Date.now()): string | null {
    this.sweepExpired(now);
    const continuation = this.continuation;
    const hash = hashToken(token);
    if (
      !token ||
      !continuation?.seeds.some(
        (seed) => seed.hash === hash && seed.bootId === sourceBootId && seed.expiresAt > now,
      )
    )
      return null;
    // Deterministic within a target boot: duplicate tabs and retried responses are idempotent.
    const session = crypto
      .createHmac("sha256", continuation.key)
      .update(`sash-web-continuation\0${continuation.bootId}\0${sourceBootId}\0${hash}`)
      .digest("hex");
    this.adoptSession(session, now);
    return session;
  }

  private sweepExpired(now: number): void {
    for (const [key, expiresAt] of this.pendingBootstraps) {
      if (expiresAt <= now) this.pendingBootstraps.delete(key);
    }
    for (const [key, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(key);
    }
    if (this.continuation && this.continuation.expiresAt <= now) this.continuation = undefined;
  }
}
