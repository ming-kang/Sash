import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { sashLayout } from "../paths.js";
import { ProfileService } from "../profile-service.js";
import { createTestState, deferred } from "../testing/state.js";
import { DaemonGate } from "./context.js";
import { type DaemonScheduler, startProfileUpdateScheduler } from "./scheduler.js";

const INTERVAL_MS = 60_000;
const KICKOFF_MS = 5_000;

interface CapturedTimer {
  callback: () => void;
  ms: number;
}

function fakeTimers() {
  const intervals: CapturedTimer[] = [];
  const timeouts: CapturedTimer[] = [];
  const cleared = { interval: 0, timeout: 0 };
  let unrefs = 0;
  const handle = () => {
    const value = {
      unref: () => {
        unrefs += 1;
        return value;
      },
    };
    return value as unknown as NodeJS.Timeout;
  };
  const scheduler: DaemonScheduler = {
    intervalMs: INTERVAL_MS,
    kickoffMs: KICKOFF_MS,
    setInterval: ((callback: () => void, ms: number) => {
      intervals.push({ callback, ms });
      return handle();
    }) as typeof setInterval,
    clearInterval: (() => {
      cleared.interval += 1;
    }) as typeof clearInterval,
    setTimeout: ((callback: () => void, ms: number) => {
      timeouts.push({ callback, ms });
      return handle();
    }) as typeof setTimeout,
    clearTimeout: (() => {
      cleared.timeout += 1;
    }) as typeof clearTimeout,
  };
  return { scheduler, intervals, timeouts, cleared, unrefs: () => unrefs };
}

function fakeProfiles() {
  const calls = { updateDue: 0, cleanup: 0 };
  const hooks = {
    updateDue: undefined as (() => Promise<void>) | undefined,
    cleanup: undefined as (() => Promise<void>) | undefined,
  };
  const service = {
    updateDue: async () => {
      calls.updateDue += 1;
      await hooks.updateDue?.();
      return { updated: 0, failed: [] };
    },
    cleanup: async () => {
      calls.cleanup += 1;
      await hooks.cleanup?.();
      return 0;
    },
  } as unknown as ProfileService;
  return { service, calls, hooks };
}

/** Drain the microtask queue so settled scheduler promises run their continuations. */
async function flush(rounds = 2): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("startProfileUpdateScheduler", () => {
  it("runs the kickoff update once, then cleans up after it completes", async () => {
    const timers = fakeTimers();
    const profiles = fakeProfiles();
    const handle = startProfileUpdateScheduler(profiles.service, timers.scheduler, () => true);
    try {
      assert.equal(timers.timeouts.length, 1);
      assert.equal(timers.timeouts[0]?.ms, KICKOFF_MS);
      assert.equal(timers.intervals.length, 1);
      assert.equal(timers.intervals[0]?.ms, INTERVAL_MS);
      assert.equal(timers.unrefs(), 2, "both timer handles are unref'd");

      timers.timeouts[0]?.callback();
      assert.equal(profiles.calls.updateDue, 1);
      assert.equal(profiles.calls.cleanup, 0, "cleanup waits for updateDue to settle");
      await flush();
      assert.equal(profiles.calls.updateDue, 1, "kickoff fires a single update");
      assert.equal(profiles.calls.cleanup, 1);
    } finally {
      handle.stop();
    }
  });

  it("runs updates on the interval timer", async () => {
    const timers = fakeTimers();
    const profiles = fakeProfiles();
    const handle = startProfileUpdateScheduler(profiles.service, timers.scheduler, () => true);
    try {
      timers.intervals[0]?.callback();
      assert.equal(profiles.calls.updateDue, 1);
      await flush();
      assert.equal(profiles.calls.cleanup, 1);
    } finally {
      handle.stop();
    }
  });

  it("skips overlapping triggers while an update is still running", async () => {
    const timers = fakeTimers();
    const profiles = fakeProfiles();
    const gate = deferred();
    profiles.hooks.updateDue = () => gate.promise;
    const handle = startProfileUpdateScheduler(profiles.service, timers.scheduler, () => true);
    try {
      timers.timeouts[0]?.callback();
      assert.equal(profiles.calls.updateDue, 1);
      timers.intervals[0]?.callback();
      timers.timeouts[0]?.callback();
      assert.equal(profiles.calls.updateDue, 1, "re-entry is blocked while running");
      gate.resolve();
      await flush();
      assert.equal(profiles.calls.cleanup, 1);

      timers.intervals[0]?.callback();
      assert.equal(profiles.calls.updateDue, 2, "the next trigger runs after completion");
      gate.resolve();
      await flush();
      assert.equal(profiles.calls.cleanup, 2);
    } finally {
      handle.stop();
    }
  });

  it("swallows updateDue failures, still cleans up, and recovers", async () => {
    const timers = fakeTimers();
    const profiles = fakeProfiles();
    let fail = true;
    profiles.hooks.updateDue = async () => {
      if (fail) throw new Error("update failed");
    };
    const handle = startProfileUpdateScheduler(profiles.service, timers.scheduler, () => true);
    try {
      timers.timeouts[0]?.callback();
      await flush();
      assert.equal(profiles.calls.cleanup, 1, "cleanup runs even after a failed update");

      fail = false;
      timers.intervals[0]?.callback();
      assert.equal(profiles.calls.updateDue, 2, "the running flag is reset after a failure");
      await flush();
      assert.equal(profiles.calls.cleanup, 2);
    } finally {
      handle.stop();
    }
  });

  it("swallows cleanup failures and keeps scheduling", async () => {
    const timers = fakeTimers();
    const profiles = fakeProfiles();
    profiles.hooks.cleanup = async () => {
      throw new Error("cleanup failed");
    };
    const handle = startProfileUpdateScheduler(profiles.service, timers.scheduler, () => true);
    try {
      timers.timeouts[0]?.callback();
      await flush();
      assert.equal(profiles.calls.cleanup, 1);
      timers.intervals[0]?.callback();
      await flush();
      assert.equal(profiles.calls.updateDue, 2);
      assert.equal(profiles.calls.cleanup, 2);
    } finally {
      handle.stop();
    }
  });

  it("does not run updates while inactive", async () => {
    const timers = fakeTimers();
    const profiles = fakeProfiles();
    let active = false;
    const handle = startProfileUpdateScheduler(profiles.service, timers.scheduler, () => active);
    try {
      timers.timeouts[0]?.callback();
      timers.intervals[0]?.callback();
      await flush();
      assert.equal(profiles.calls.updateDue, 0);
      assert.equal(profiles.calls.cleanup, 0);

      active = true;
      timers.intervals[0]?.callback();
      assert.equal(profiles.calls.updateDue, 1);
      await flush();
      assert.equal(profiles.calls.cleanup, 1);
    } finally {
      handle.stop();
    }
  });

  it("skips cleanup when the daemon becomes inactive during an update", async () => {
    const timers = fakeTimers();
    const profiles = fakeProfiles();
    const gate = deferred();
    profiles.hooks.updateDue = () => gate.promise;
    let active = true;
    const handle = startProfileUpdateScheduler(profiles.service, timers.scheduler, () => active);
    try {
      timers.timeouts[0]?.callback();
      active = false;
      gate.resolve();
      await flush();
      assert.equal(profiles.calls.cleanup, 0, "cleanup requires an active daemon");

      active = true;
      timers.intervals[0]?.callback();
      assert.equal(profiles.calls.updateDue, 2, "the running flag is still reset");
    } finally {
      handle.stop();
    }
  });

  it("stop() clears both timers, is idempotent, and blocks later triggers", async () => {
    const timers = fakeTimers();
    const profiles = fakeProfiles();
    const handle = startProfileUpdateScheduler(profiles.service, timers.scheduler, () => true);
    handle.stop();
    assert.equal(timers.cleared.interval, 1);
    assert.equal(timers.cleared.timeout, 1);
    handle.stop();
    assert.equal(timers.cleared.interval, 1, "second stop() is a no-op");
    assert.equal(timers.cleared.timeout, 1);

    timers.timeouts[0]?.callback();
    timers.intervals[0]?.callback();
    await flush();
    assert.equal(profiles.calls.updateDue, 0);
    assert.equal(profiles.calls.cleanup, 0);
  });

  it("does not clean up when an in-flight update finishes after stop()", async () => {
    const timers = fakeTimers();
    const profiles = fakeProfiles();
    const gate = deferred();
    profiles.hooks.updateDue = () => gate.promise;
    const handle = startProfileUpdateScheduler(profiles.service, timers.scheduler, () => true);
    timers.timeouts[0]?.callback();
    assert.equal(profiles.calls.updateDue, 1);
    handle.stop();
    gate.resolve();
    await flush();
    assert.equal(profiles.calls.cleanup, 0, "stopped schedulers skip cleanup");

    timers.intervals[0]?.callback();
    assert.equal(profiles.calls.updateDue, 1, "stopped schedulers never re-enter");
  });

  it("does not trigger mutation notifications on idle ticks with nothing to prune", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-scheduler-idle-test-"));
    try {
      const layout = sashLayout(root);
      fs.mkdirSync(layout.profilesDir, { recursive: true });
      fs.mkdirSync(layout.tempDir, { recursive: true });
      const state = createTestState(layout);
      let notifications = 0;
      const gate = new DaemonGate(
        async () => {},
        () => {},
        {
          onChange: () => {
            notifications += 1;
          },
        },
      );
      const profileService = new ProfileService({
        layout,
        state,
        commit: (action) => gate.mutate(action),
        assertMutable: () => gate.assertMutable(),
      });
      const timers = fakeTimers();
      const handle = startProfileUpdateScheduler(profileService, timers.scheduler, () => true);
      try {
        // Kickoff idle tick
        timers.timeouts[0]?.callback();
        await flush();
        assert.equal(notifications, 0, "kickoff idle tick must not emit mutation notification");

        // Interval idle tick
        timers.intervals[0]?.callback();
        await flush();
        assert.equal(notifications, 0, "interval idle tick must not emit mutation notification");
      } finally {
        handle.stop();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("triggers mutation notification when a stale file is pruned", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-scheduler-stale-test-"));
    try {
      const layout = sashLayout(root);
      const profileDir = path.join(layout.profilesDir, "1");
      fs.mkdirSync(profileDir, { recursive: true });
      fs.mkdirSync(layout.tempDir, { recursive: true });
      const state = createTestState(layout);

      // Create a stale profile file (> 24 hours old, not active revision)
      const staleFile = path.join(profileDir, "99.yaml");
      fs.writeFileSync(staleFile, "rules: [MATCH,DIRECT]\n");
      const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
      fs.utimesSync(staleFile, staleTime, staleTime);

      let notifications = 0;
      const gate = new DaemonGate(
        async () => {},
        () => {},
        {
          onChange: () => {
            notifications += 1;
          },
        },
      );
      const profileService = new ProfileService({
        layout,
        state,
        commit: (action) => gate.mutate(action),
        assertMutable: () => gate.assertMutable(),
      });
      const timers = fakeTimers();
      const handle = startProfileUpdateScheduler(profileService, timers.scheduler, () => true);
      try {
        timers.timeouts[0]?.callback();
        await flush();
        assert.equal(fs.existsSync(staleFile), false, "stale file was pruned");
        assert.equal(notifications, 1, "commit and notify triggered when stale file was pruned");

        // Subsequent idle tick has nothing left to prune -> no new notification
        timers.intervals[0]?.callback();
        await flush();
        assert.equal(notifications, 1, "subsequent idle tick did not emit additional notification");
      } finally {
        handle.stop();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
