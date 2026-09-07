import crypto from "node:crypto";

/** One-time browser bootstrap tokens stay valid long enough for `sash web` to
 * write the bootstrap file and for the browser to load it, but no longer. */
export const WEB_BOOTSTRAP_TTL_MS = 90_000;
const MAX_PENDING_BOOTSTRAPS = 32;
const MAX_SESSIONS = 256;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * In-memory WebUI credentials. Bootstrap tokens are single-use and short
 * lived; session tokens authorize control requests until the daemon exits.
 * Nothing is persisted, so a daemon restart invalidates every session.
 */
export class WebAuthManager {
  /** Hashed bootstrap token -> expiry (ms since epoch), in insertion order. */
  private readonly pendingBootstraps = new Map<string, number>();
  /** Hashed session tokens, in insertion order for bounded eviction. */
  private readonly sessions = new Map<string, true>();

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
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const session = crypto.randomBytes(32).toString("hex");
    this.sessions.set(hashToken(session), true);
    return session;
  }

  isSession(token: string): boolean {
    return token !== "" && this.sessions.has(hashToken(token));
  }

  private sweepExpired(now: number): void {
    for (const [key, expiresAt] of this.pendingBootstraps) {
      if (expiresAt <= now) this.pendingBootstraps.delete(key);
    }
  }
}
