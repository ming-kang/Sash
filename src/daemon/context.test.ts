import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deferred } from "../test-state.test.js";
import { DaemonGate, type SlowMutationInfo } from "./context.js";

describe("daemon mutation queue", () => {
  it("reports synchronous slow work and preserves the domain error if diagnostics fail", async (t) => {
    let now = 0;
    let reports = 0;
    t.mock.method(performance, "now", () => now);
    const failure = new Error("save failed");
    const gate = new DaemonGate(
      async () => {},
      () => {},
      {
        slowMutationMs: 5,
        onSlowMutation: () => {
          reports += 1;
          throw new Error("logging failed");
        },
      },
    );
    await assert.rejects(
      gate.mutate("synchronous write", () => {
        now = 20;
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(reports, 1);
    assert.deepEqual(gate.snapshot(), { active: null, queued: 0 });
    assert.equal(await gate.mutate("next", () => 42), 42);
  });

  it("reports active purpose, start time and queued operations without exposing mutable state", async () => {
    const entered = deferred();
    const release = deferred();
    const gate = new DaemonGate(
      async () => {},
      () => {},
    );
    const first = gate.mutate("apply configuration", async () => {
      entered.resolve();
      await release.promise;
      return "first";
    });
    const second = gate.mutate("save settings", () => "second");
    await entered.promise;
    const observed = gate.snapshot();
    assert.equal(observed.active?.purpose, "apply configuration");
    assert.equal(observed.queued, 1);
    assert.match(observed.active?.startedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    if (observed.active) observed.active.purpose = "external mutation";
    assert.equal(gate.snapshot().active?.purpose, "apply configuration");
    release.resolve();
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.deepEqual(gate.snapshot(), { active: null, queued: 0 });
  });

  it("cancels queued mutations during shutdown and recovers its counters after failed cleanup", async () => {
    const entered = deferred();
    const release = deferred();
    let cleanups = 0;
    const gate: DaemonGate = new DaemonGate(
      async (): Promise<void> => {
        assert.equal(gate.snapshot().active?.purpose, "shut down daemon");
        if (++cleanups === 1) throw new Error("cleanup failed");
      },
      () => {},
    );
    const first = gate.mutate("active", async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const queued = assert.rejects(
      gate.mutate("cancelled", () => assert.fail("must not run")),
      /shutting down/,
    );
    const shutdown = assert.rejects(gate.shutdown(), /cleanup failed/);
    release.resolve();
    await Promise.all([first, queued, shutdown]);
    assert.equal(gate.isClosing, false);
    assert.deepEqual(gate.snapshot(), { active: null, queued: 0 });
    await assert.rejects(
      gate.mutate("failing write", () => {
        throw new Error("write failed");
      }),
      /write failed/,
    );
    assert.equal(await gate.mutate("next write", () => 42), 42);
    await gate.shutdown();
    assert.equal(gate.isClosing, true);
    assert.deepEqual(gate.snapshot(), { active: null, queued: 0 });
  });

  it("reports a slow operation once and clears its timer after completion", async () => {
    const messages: SlowMutationInfo[] = [];
    const release = deferred();
    const entered = deferred();
    const gate = new DaemonGate(
      async () => {},
      () => {},
      {
        slowMutationMs: 5,
        onSlowMutation: (message) => messages.push(message),
      },
    );
    const slow = gate.mutate("slow apply", async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const queued = gate.mutate("quick write", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.purpose, "slow apply");
    assert.equal(messages[0]?.queued, 1);
    release.resolve();
    await Promise.all([slow, queued]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messages.length, 1);
  });
});
