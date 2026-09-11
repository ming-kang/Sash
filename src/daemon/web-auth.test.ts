import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { WEB_BOOTSTRAP_TTL_MS, WebAuthManager } from "./auth.js";

const WEB_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function tempSessionsFile(parent: string, name: string): string {
  return path.join(fs.mkdtempSync(path.join(parent, name)), "web-sessions.json");
}

function readSeeds(file: string): { hash: string; expiresAt: number }[] {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    seeds: { hash: string; expiresAt: number }[];
  };
  return parsed.seeds;
}

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

  it("consumes each bootstrap token once and rejects unknown or expired grants", () => {
    const auth = new WebAuthManager();
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

  it("keeps a session across daemon restarts through the persisted session file", (t) => {
    const parent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, "sash-web-auth-continuation-"));
    t.after(() => {
      assert.equal(path.dirname(fs.realpathSync(root)), parent);
      fs.rmSync(root, { recursive: true, force: true });
    });
    const file = path.join(root, "web-sessions.json");
    const now = Date.now();

    const old = new WebAuthManager(file);
    const session = old.redeemBootstrap(old.createBootstrap(now).token, now);
    assert.ok(session);
    const seeds = readSeeds(file);
    assert.equal(seeds.length, 1);
    assert.deepEqual(Object.keys(seeds[0] ?? {}).sort(), ["expiresAt", "hash"]);
    assert.equal(seeds[0]?.expiresAt, now + WEB_SESSION_TTL_MS);
    // The file stores hashes, never the browser credentials themselves.
    assert.notEqual(seeds[0]?.hash, session);

    const next = new WebAuthManager(file);
    assert.equal(next.isSession(session, now), true);

    // Expired seeds are dropped when the file loads.
    const expired = readSeeds(file);
    if (expired[0]) expired[0].expiresAt = now - 1;
    fs.writeFileSync(file, JSON.stringify({ seeds: expired }));
    assert.equal(new WebAuthManager(file).isSession(session, now), false);
  });

  it("persists a session once its deadline slides past half the lifetime", (t) => {
    const parent = fs.realpathSync(os.tmpdir());
    const file = tempSessionsFile(parent, "sash-web-auth-persist-");
    t.after(() => {
      assert.equal(path.dirname(path.dirname(fs.realpathSync(file))), parent);
      fs.rmSync(path.dirname(fs.realpathSync(file)), { recursive: true, force: true });
    });
    const now = Date.now();
    const auth = new WebAuthManager(file);
    const session = auth.redeemBootstrap(auth.createBootstrap(now).token, now);
    assert.ok(session);
    assert.equal(readSeeds(file)[0]?.expiresAt, now + WEB_SESSION_TTL_MS);

    // Within half a lifetime the slide stays in memory.
    assert.equal(auth.isSession(session, now + WEB_SESSION_TTL_MS / 3), true);
    assert.equal(readSeeds(file)[0]?.expiresAt, now + WEB_SESSION_TTL_MS);

    // Beyond half a lifetime the new deadline reaches the file.
    const late = now + WEB_SESSION_TTL_MS * 0.9;
    assert.equal(auth.isSession(session, late), true);
    assert.equal(readSeeds(file)[0]?.expiresAt, late + WEB_SESSION_TTL_MS);
  });

  it("tolerates a missing or unreadable session file", (t) => {
    const parent = fs.realpathSync(os.tmpdir());
    const file = tempSessionsFile(parent, "sash-web-auth-unreadable-");
    t.after(() => {
      assert.equal(path.dirname(path.dirname(fs.realpathSync(file))), parent);
      fs.rmSync(path.dirname(fs.realpathSync(file)), { recursive: true, force: true });
    });
    fs.writeFileSync(file, "{ not a session file");
    const corrupt = new WebAuthManager(file);
    const session = corrupt.redeemBootstrap(corrupt.createBootstrap().token);
    assert.ok(session);
    assert.equal(corrupt.isSession(session), true);
    const memoryOnly = new WebAuthManager();
    assert.equal(memoryOnly.isSession(session), false);
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
