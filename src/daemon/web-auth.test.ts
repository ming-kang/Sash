import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  WEB_BOOTSTRAP_TTL_MS,
  WEB_SESSION_TTL_MS,
  WebAuthManager,
  type WebSessionSeed,
} from "./web-auth.js";

const BOOT_ID = "a".repeat(48);

function tempSessionsFile(parent: string, name: string): string {
  return path.join(fs.mkdtempSync(path.join(parent, name)), "web-sessions.json");
}

describe("WebAuthManager", () => {
  it("expires inactive sessions and slides the deadline only for accepted credentials", () => {
    const auth = new WebAuthManager(BOOT_ID);
    const now = Date.now();
    const active = auth.redeemBootstrap(auth.createBootstrap(now).token, now);
    const idle = auth.redeemBootstrap(auth.createBootstrap(now).token, now);
    assert.ok(active && idle);
    assert.equal(auth.isSession(active, now + WEB_SESSION_TTL_MS - 1), true);
    assert.equal(auth.isSession(idle, now + WEB_SESSION_TTL_MS), false);
    assert.equal(auth.isSession(active, now + WEB_SESSION_TTL_MS), true);
    assert.equal(auth.isSession(active, now + WEB_SESSION_TTL_MS * 2), false);
  });

  it("consumes each bootstrap token once and rejects unknown or expired grants", () => {
    const auth = new WebAuthManager(BOOT_ID);
    const now = Date.now();
    const bootstrap = auth.createBootstrap(now);
    const session = auth.redeemBootstrap(bootstrap.token, now);
    assert.ok(session);
    assert.equal(auth.redeemBootstrap(bootstrap.token, now), null);
    assert.equal(auth.redeemBootstrap("unknown", now), null);
    assert.equal(auth.redeemBootstrap("", now), null);
    assert.equal(auth.isSession(session, now), true);
    const expired = auth.createBootstrap(now);
    assert.equal(auth.redeemBootstrap(expired.token, now + WEB_BOOTSTRAP_TTL_MS), null);
    assert.equal(auth.isSession(expired.token, now), false);
  });

  it("continues a session across daemon generations through the persisted session file", (t) => {
    const parent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, "sash-web-auth-continuation-"));
    t.after(() => {
      assert.equal(path.dirname(fs.realpathSync(root)), parent);
      fs.rmSync(root, { recursive: true, force: true });
    });
    const file = path.join(root, "web-sessions.json");
    const now = Date.now();
    const sourceBoot = "b".repeat(48);
    const targetBoot = "c".repeat(48);

    const old = new WebAuthManager(sourceBoot, file);
    const session = old.redeemBootstrap(old.createBootstrap(now).token, now);
    assert.ok(session);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as { seeds: WebSessionSeed[] };
    assert.equal(persisted.seeds.length, 1);
    assert.equal(persisted.seeds[0]?.bootId, sourceBoot);
    assert.equal(persisted.seeds[0]?.expiresAt, now + WEB_SESSION_TTL_MS);
    // The file stores hashes, never the browser credentials themselves.
    assert.notEqual(persisted.seeds[0]?.hash, session);

    const next = new WebAuthManager(targetBoot, file);
    assert.equal(next.isSession(session, now), false);
    assert.equal(next.isContinuationToken(session, now), true);
    assert.deepEqual(next.continuationInfo(now), {
      bootIds: [sourceBoot],
      expiresAt: new Date(now + WEB_SESSION_TTL_MS).toISOString(),
    });
    assert.equal(next.redeemContinuation(session, "d".repeat(48), now), null);
    assert.equal(next.redeemContinuation("unknown", sourceBoot, now), null);
    const renewed = next.redeemContinuation(session, sourceBoot, now);
    assert.ok(renewed);
    assert.notEqual(renewed, session);
    assert.equal(next.isSession(renewed, now), true);
    // Duplicate tabs and retried responses get the same session token.
    assert.equal(next.redeemContinuation(session, sourceBoot, now), renewed);
    assert.equal(next.redeemContinuation(session, sourceBoot, now + WEB_SESSION_TTL_MS), null);
    assert.equal(next.continuationInfo(now + WEB_SESSION_TTL_MS), undefined);
    assert.equal(next.isContinuationToken(session, now + WEB_SESSION_TTL_MS), false);
  });

  it("requires a readable persisted session file to continue a session", (t) => {
    const parent = fs.realpathSync(os.tmpdir());
    const file = tempSessionsFile(parent, "sash-web-auth-unreadable-");
    t.after(() => {
      assert.equal(path.dirname(path.dirname(fs.realpathSync(file))), parent);
      fs.rmSync(path.dirname(fs.realpathSync(file)), { recursive: true, force: true });
    });
    fs.writeFileSync(file, "{ not a session file");
    const corrupt = new WebAuthManager(BOOT_ID, file);
    assert.equal(corrupt.continuationInfo(), undefined);
    const session = corrupt.redeemBootstrap(corrupt.createBootstrap().token);
    assert.ok(session);
    assert.equal(corrupt.isSession(session), true);
    const memoryOnly = new WebAuthManager(BOOT_ID);
    assert.equal(memoryOnly.continuationInfo(), undefined);
    assert.equal(memoryOnly.isContinuationToken(session), false);
    assert.equal(memoryOnly.redeemContinuation(session, BOOT_ID), null);
  });

  it("bounds pending bootstraps and sessions by evicting the oldest", () => {
    const auth = new WebAuthManager(BOOT_ID);
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
