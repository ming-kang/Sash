import crypto from "node:crypto";
import fs from "node:fs";
import type { WebContinuationInfo } from "../contracts.js";
import { atomicWriteFileSync } from "../fs-atomic.js";
import { isPlainObject } from "../json-shape.js";

/** One-time browser bootstrap tokens stay valid long enough for `sash web` to
 * write the bootstrap file and for the browser to load it, but no longer. */
export const WEB_BOOTSTRAP_TTL_MS = 90_000;
const MAX_PENDING_BOOTSTRAPS = 32;
const MAX_SESSIONS = 256;
export const WEB_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_FILE_LIMIT = 256 * 1024;

export interface WebSessionSeed {
  hash: string;
  bootId: string;
  expiresAt: number;
}

export function parseWebSessionSeeds(value: unknown): WebSessionSeed[] {
  const seeds = (value as { seeds?: unknown })?.seeds;
  if (!Array.isArray(seeds) || seeds.length > MAX_SESSIONS * 2) return [];
  return seeds.flatMap((seed: unknown): WebSessionSeed[] => {
    const record = seed as Record<string, unknown> | null;
    if (
      !isPlainObject(record) ||
      typeof record.hash !== "string" ||
      typeof record.bootId !== "string" ||
      typeof record.expiresAt !== "number" ||
      !Number.isSafeInteger(record.expiresAt)
    )
      return [];
    return [{ hash: record.hash, bootId: record.bootId, expiresAt: record.expiresAt }];
  });
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * In-memory WebUI credentials, with the hashes of this daemon generation's
 * sessions persisted beside the other state so a browser can exchange them for
 * a session on the next generation without a new `sash web` authorization.
 */
export class WebAuthManager {
  /** Hashed bootstrap token -> expiry (ms since epoch), in insertion order. */
  private readonly pendingBootstraps = new Map<string, number>();
  /** Hashed session tokens, in insertion order for bounded eviction. */
  private readonly sessions = new Map<string, number>();
  private continuation: { seeds: WebSessionSeed[]; key: string; bootId: string } | undefined;

  constructor(
    private readonly bootId: string,
    private readonly sessionsFile?: string,
  ) {
    if (!sessionsFile) return;
    try {
      const text = fs.readFileSync(sessionsFile, "utf8");
      if (text.length > SESSION_FILE_LIMIT) return;
      const seeds = parseWebSessionSeeds(JSON.parse(text) as unknown);
      if (seeds.length)
        this.continuation = { seeds, key: crypto.randomBytes(32).toString("hex"), bootId };
    } catch {
      /* A missing or unreadable session file only means no browser can continue. */
    }
  }

  /** Persist this generation's session hashes for the next daemon generation. */
  private persist(): void {
    if (!this.sessionsFile || !this.sessions.size) return;
    const seeds = this.sessionSeeds();
    try {
      atomicWriteFileSync(this.sessionsFile, `${JSON.stringify({ seeds })}\n`, 0o600);
    } catch {
      /* Session persistence is an optimization; the live daemon keeps working. */
    }
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

  private adoptSession(token: string, now: number, persist = true): void {
    const hash = hashToken(token);
    const known = this.sessions.has(hash);
    this.sessions.delete(hash);
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    this.sessions.set(hash, now + WEB_SESSION_TTL_MS);
    if (persist && !known) this.persist();
  }

  /** Seeds of this generation plus the ones inherited from earlier generations. */
  private sessionSeeds(now = Date.now()): WebSessionSeed[] {
    this.sweepExpired(now);
    const existing = this.continuation?.seeds.filter((seed) => seed.expiresAt > now) ?? [];
    return [
      ...existing,
      ...Array.from(this.sessions, ([hash, expiresAt]) => ({
        hash,
        expiresAt,
        bootId: this.bootId,
      })),
    ].slice(-MAX_SESSIONS * 2);
  }

  continuationInfo(now = Date.now()): WebContinuationInfo | undefined {
    this.sweepExpired(now);
    const seeds = this.continuation?.seeds.filter((seed) => seed.expiresAt > now) ?? [];
    const bootIds = [...new Set(seeds.map((seed) => seed.bootId))];
    return bootIds.length
      ? {
          bootIds,
          expiresAt: new Date(Math.max(...seeds.map((seed) => seed.expiresAt))).toISOString(),
        }
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
  }
}
