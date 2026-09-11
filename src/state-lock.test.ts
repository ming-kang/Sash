import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  acquireStateLock,
  type StateLockRecord,
  StateMutationQueue,
  withStateLock,
} from "./state-lock.js";

describe("state locks", () => {
  let tmpDir: string;
  let lockFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-state-lock-test-"));
    lockFile = path.join(tmpDir, "state", "test.lock");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  function writeLock(record: StateLockRecord): void {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  it("waits asynchronously without blocking the owner release", async () => {
    const owner = await acquireStateLock(lockFile, { purpose: "initial owner" });
    const pending = acquireStateLock(lockFile, {
      purpose: "next owner",
      // The assertion concerns yielding to the owner's setImmediate, not host
      // filesystem latency. Shared Windows runners can take over 500 ms here.
      timeoutMs: 5000,
      pollMs: 10,
    });

    await new Promise<void>((resolve) => {
      setImmediate(() => {
        owner.release();
        resolve();
      });
    });
    const lease = await pending;
    try {
      assert.equal(lease.record.purpose, "next owner");
    } finally {
      lease.release();
    }
  });

  it("reclaims a lock held by a dead owner", async () => {
    const deadOwner: StateLockRecord = {
      pid: 2_147_483_647,
      token: "dead-async-owner-token",
      purpose: "dead async owner",
    };
    writeLock(deadOwner);

    const lease = await acquireStateLock(lockFile, { purpose: "async replacement", timeoutMs: 0 });
    try {
      assert.notEqual(lease.record.token, deadOwner.token);
      assert.equal(lease.record.purpose, "async replacement");
      assert.equal(
        fs.readdirSync(path.dirname(lockFile)).some((name) => name.includes(".stale.")),
        false,
      );
    } finally {
      lease.release();
    }
  });

  it("enforces mutual exclusion and reports the live owner", async () => {
    const first = await acquireStateLock(lockFile, { purpose: "first owner" });
    try {
      await assert.rejects(
        acquireStateLock(lockFile, { purpose: "second owner", timeoutMs: 20, pollMs: 5 }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes(lockFile));
          assert.ok(err.message.includes(`owner PID ${process.pid}`));
          assert.ok(err.message.includes('purpose "first owner"'));
          return true;
        },
      );
    } finally {
      first.release();
    }
  });

  it("reclaims a corrupt record left behind by an interrupted write", async () => {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, "{ not valid JSON");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, past, past);

    const lease = await acquireStateLock(lockFile, { purpose: "replacement" });
    try {
      assert.equal(lease.record.purpose, "replacement");
    } finally {
      lease.release();
    }
  });

  it("leaves a record that may still be mid-write alone", async () => {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, "{ not valid JSON");

    await assert.rejects(acquireStateLock(lockFile, { purpose: "blocked", timeoutMs: 0 }), /busy/);
    assert.equal(fs.readFileSync(lockFile, "utf8"), "{ not valid JSON");
  });

  it("does not delete a replacement lock when releasing a mismatched token", async () => {
    const lease = await acquireStateLock(lockFile, { purpose: "original" });
    const replacement: StateLockRecord = {
      ...lease.record,
      token: "replacement-token",
      purpose: "replacement",
    };
    const replacementText = `${JSON.stringify(replacement)}\n`;
    fs.writeFileSync(lockFile, replacementText);

    lease.release();

    assert.equal(fs.readFileSync(lockFile, "utf8"), replacementText);
  });

  it("releases a lock when withStateLock actions throw", async () => {
    await assert.rejects(
      withStateLock(lockFile, { purpose: "throwing action" }, async () => {
        throw new Error("action failed");
      }),
      /action failed/,
    );

    assert.equal(fs.existsSync(lockFile), false);
    const next = await acquireStateLock(lockFile, { purpose: "next action" });
    next.release();
  });

  it("serializes queued mutations and releases the cross-process lock afterward", async () => {
    const queue = new StateMutationQueue(lockFile);
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run("first mutation", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.run("second mutation", () => {
      events.push("second");
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["first:start"]);
    releaseFirst?.();
    await Promise.all([first, second]);

    assert.deepEqual(events, ["first:start", "first:end", "second"]);
    assert.equal(fs.existsSync(lockFile), false);
  });
});
