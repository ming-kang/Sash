import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WEB_BOOTSTRAP_TTL_MS, WEB_SESSION_TTL_MS, WebAuthManager } from "./web-auth.js";

describe("WebAuthManager", () => {
  it("expires inactive sessions and slides the deadline only for accepted credentials", () => {
    const auth = new WebAuthManager();
    const now = Date.now();
    const active = auth.redeemBootstrap(auth.createBootstrap(now).token, now);
    const idle = auth.redeemBootstrap(auth.createBootstrap(now).token, now);
    assert.ok(active && idle);
    assert.equal(auth.isSession(active, now + WEB_SESSION_TTL_MS - 1), true);
    assert.equal(auth.isSession(idle, now + WEB_SESSION_TTL_MS), false);
    assert.equal(auth.isSession(active, now + WEB_SESSION_TTL_MS), true);
    assert.equal(auth.isSession(active, now + WEB_SESSION_TTL_MS * 2), false);
  });

  it("requires a private old token and source boot for a bounded idempotent continuation", () => {
    const now = Date.now();
    const old = new WebAuthManager();
    const session = old.redeemBootstrap(old.createBootstrap(now).token, now);
    assert.ok(session);
    const boot = "b".repeat(48);
    const targetBoot = "c".repeat(48);
    const next = new WebAuthManager();
    next.installContinuation(old.sessionSeeds(boot, now), "d".repeat(64), targetBoot, now + 1000);
    assert.equal(next.isSession(session, now), false);
    assert.equal(next.isContinuationToken(session, now), true);
    assert.equal(next.redeemContinuation(boot, boot, now), null);
    assert.equal(next.redeemContinuation(session, targetBoot, now), null);
    const renewed = next.redeemContinuation(session, boot, now);
    assert.ok(renewed);
    assert.notEqual(renewed, session);
    assert.equal(next.isSession(renewed, now), true);
    assert.equal(next.redeemContinuation(session, boot, now), renewed);
    assert.equal(next.redeemContinuation(session, boot, now + 1000), null);
    assert.equal(next.continuationInfo(now + 1000), undefined);
  });
  it("redeems a bootstrap token exactly once and authorizes the session", () => {
    const auth = new WebAuthManager();
    const bootstrap = auth.createBootstrap();
    assert.notEqual(bootstrap.token, "");

    const session = auth.redeemBootstrap(bootstrap.token);
    assert.notEqual(session, null);
    assert.equal(auth.isSession(session as string), true);

    // Single use: the same bootstrap token cannot mint a second session.
    assert.equal(auth.redeemBootstrap(bootstrap.token), null);
  });

  it("rejects unknown, empty and expired bootstrap tokens", () => {
    const auth = new WebAuthManager();
    const now = Date.now();
    const bootstrap = auth.createBootstrap(now);

    assert.equal(auth.redeemBootstrap("", now), null);
    assert.equal(auth.redeemBootstrap("f".repeat(64), now), null);
    assert.notEqual(auth.redeemBootstrap(bootstrap.token, now + WEB_BOOTSTRAP_TTL_MS - 1), null);
    const expired = auth.createBootstrap(now);
    assert.equal(auth.redeemBootstrap(expired.token, now + WEB_BOOTSTRAP_TTL_MS), null);
    assert.equal(auth.redeemBootstrap(expired.token, now + WEB_BOOTSTRAP_TTL_MS + 1), null);
  });

  it("does not authorize arbitrary tokens as sessions", () => {
    const auth = new WebAuthManager();
    auth.createBootstrap();
    assert.equal(auth.isSession(""), false);
    assert.equal(auth.isSession("a".repeat(64)), false);
  });

  it("invalidates bootstrap and session credentials when the daemon restarts", () => {
    const before = new WebAuthManager();
    const bootstrap = before.createBootstrap();
    const session = before.redeemBootstrap(before.createBootstrap().token);
    assert.ok(session);
    const after = new WebAuthManager();
    assert.equal(after.redeemBootstrap(bootstrap.token), null);
    assert.equal(after.isSession(session), false);
  });

  it("bounds pending bootstraps and sessions by evicting the oldest", () => {
    const auth = new WebAuthManager();
    const tokens: string[] = [];
    for (let i = 0; i < 40; i += 1) tokens.push(auth.createBootstrap().token);
    // Only the most recent 32 pending bootstraps survive.
    assert.equal(auth.redeemBootstrap(tokens[0] as string), null);
    assert.notEqual(auth.redeemBootstrap(tokens[39] as string), null);

    const sessions: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const session = auth.redeemBootstrap(auth.createBootstrap().token);
      assert.notEqual(session, null);
      sessions.push(session as string);
    }
    assert.equal(auth.isSession(sessions[0] as string), false);
    assert.equal(auth.isSession(sessions[299] as string), true);
  });
});
