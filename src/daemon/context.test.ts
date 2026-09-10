import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deferred } from "../testing/state.js";
import { DaemonGate, type SlowMutationInfo } from "./context.js";

describe("daemon mutation queue", () => {
  it("closes admission on shutdown and drains a running write and a runtime RPC", async () => {
    const write = deferred();
    const rpc = deferred();
    const entered = deferred();
    let cancelled = 0;
    let cleanups = 0;
    const gate = new DaemonGate(
      async () => {
        cleanups += 1;
      },
      () => {
        cancelled += 1;
      },
    );
    const running = gate.mutate("write", async () => {
      entered.resolve();
      await write.promise;
    });
    await entered.promise;
    const live = gate.runLiveMutation(() => rpc.promise);
    const shutdown = gate.shutdown();
    assert.equal(gate.isClosing, true);
    assert.equal(cancelled, 1);
    await assert.rejects(
      gate.mutate("after shutdown", () => assert.fail("must not run")),
      /shutting down/,
    );
    await assert.rejects(
      gate.runLiveMutation(() => assert.fail("must not run")),
      /shutting down/,
    );
    write.resolve();
    await running;
    // Cleanup must wait for the runtime RPC that shutdown already admitted.
    assert.equal(cleanups, 0);
    rpc.resolve();
    await live;
    await shutdown;
    assert.equal(cleanups, 1);
  });

  it("rejects mutations only while the gate is closing", async () => {
    const gate = new DaemonGate(
      async () => {},
      () => {},
    );
    gate.assertMutable();
    assert.equal(await gate.mutate("write", () => 41), 41);
    assert.equal(gate.isClosing, false);
    await gate.shutdown();
    assert.equal(gate.isClosing, true);
    assert.throws(() => gate.assertMutable(), /shutting down/);
    await assert.rejects(
      gate.mutate("after shutdown", () => assert.fail("must not run")),
      /shutting down/,
    );
    gate.reopen();
    assert.equal(gate.isClosing, false);
    gate.assertMutable();
    assert.equal(await gate.mutate("after reopen", () => 42), 42);
  });

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
    assert.equal(await gate.mutate("next", () => 42), 42);
  });

  it("cancels queued mutations during shutdown and recovers its counters after failed cleanup", async () => {
    const entered = deferred();
    const release = deferred();
    let cleanups = 0;
    const gate: DaemonGate = new DaemonGate(
      async (): Promise<void> => {
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
    await assert.rejects(
      gate.mutate("failing write", () => {
        throw new Error("write failed");
      }),
      /write failed/,
    );
    assert.equal(await gate.mutate("next write", () => 42), 42);
    await gate.shutdown();
    assert.equal(gate.isClosing, true);
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
