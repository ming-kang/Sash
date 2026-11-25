import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { sashLayout } from "../paths.js";
import type { HostedCore } from "../tun-service.js";
import { HELPER_PROTOCOL, type HelperReply } from "./helper-pipe.js";
import { WindowsTunGuard } from "./windows-guard.js";

const layout = sashLayout("C:\\Users\\Dev User\\AppData\\Local\\Sash");

function reply(patch: Partial<HelperReply> = {}): HelperReply {
  return { ok: true, protocol: HELPER_PROTOCOL, home: layout.root, running: false, ...patch };
}

function fixture({
  probe,
  unguard,
}: {
  probe?: () => Promise<HelperReply>;
  unguard?: () => Promise<void>;
} = {}) {
  const host: HostedCore & { unguards: number } = {
    unguards: 0,
    async start() {
      return { pid: 77 };
    },
    async stop() {},
    async unguard() {
      host.unguards += 1;
      await unguard?.();
    },
    async status() {
      return { running: false, pid: null };
    },
  };
  const guard = new WindowsTunGuard({
    host,
    probe: probe ?? (async () => reply()),
  });
  return { guard, host };
}

describe("WindowsTunGuard setup reconcile", () => {
  it("is a successful no-op when the helper speaks the guard protocol", async () => {
    const f = fixture();
    await f.guard.reconcile("setup");
    assert.equal(f.host.unguards, 0);
    assert.equal(f.guard.lastResult()?.state, "ok");
    assert.equal(f.guard.lastResult()?.verb, "setup");
  });

  it("reports a protocol-1 helper as unavailable instead of pretending convergence", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    const f = fixture({ probe: async () => reply({ protocol: 1 }) });
    await f.guard.reconcile("setup");
    const result = f.guard.lastResult();
    assert.equal(result?.state, "unavailable");
    assert.match(result?.detail ?? "", /protocol 1/);
    assert.match(result?.detail ?? "", /sash tun helper install/);
    assert.equal(warnings.length, 1);
  });

  it("reports a missing helper as unavailable", async () => {
    const f = fixture({
      probe: async () => {
        throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
      },
    });
    await f.guard.reconcile("setup");
    const result = f.guard.lastResult();
    assert.equal(result?.state, "unavailable");
    assert.match(result?.detail ?? "", /unreachable/);
  });

  it("reports an unexpected probe failure as failed without rejecting", async () => {
    const f = fixture({
      probe: async () => {
        throw new Error("pipe timed out");
      },
    });
    await f.guard.reconcile("setup");
    const result = f.guard.lastResult();
    assert.equal(result?.state, "failed");
    assert.match(result?.detail ?? "", /pipe timed out/);
  });
});

describe("WindowsTunGuard teardown reconcile", () => {
  it("calls the host unguard operation and records success", async () => {
    const f = fixture();
    await f.guard.reconcile("teardown");
    assert.equal(f.host.unguards, 1);
    assert.equal(f.guard.lastResult()?.state, "ok");
    assert.equal(f.guard.lastResult()?.verb, "teardown");
  });

  it("records an unguard failure without rejecting", async () => {
    const f = fixture({
      unguard: async () => {
        throw new Error("pipe busy");
      },
    });
    await f.guard.reconcile("teardown");
    const result = f.guard.lastResult();
    assert.equal(f.host.unguards, 1);
    assert.equal(result?.state, "failed");
    assert.match(result?.detail ?? "", /pipe busy/);
  });

  it("classifies a protocol-1 unguard failure for doctor", async () => {
    const f = fixture({
      probe: async () => reply({ protocol: 1 }),
      unguard: async () => {
        throw new Error(`unknown op "unguard"`);
      },
    });
    await f.guard.reconcile("teardown");
    const result = f.guard.lastResult();
    assert.equal(result?.state, "unavailable");
    assert.match(result?.detail ?? "", /protocol 1/);
    assert.match(result?.detail ?? "", /sash tun helper install/);
  });
});

describe("WindowsTunGuard serialization", () => {
  it("never overlaps operations and coalesces queued reconciles to the latest state", async () => {
    const gate: Array<() => void> = [];
    const events: string[] = [];
    const f = fixture({
      probe: async () => {
        events.push("probe");
        return reply();
      },
      unguard: async () => {
        events.push("unguard");
        await new Promise<void>((resolve) => gate.push(resolve));
      },
    });
    const first = f.guard.reconcile("teardown");
    const second = f.guard.reconcile("setup");
    const third = f.guard.reconcile("teardown");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["unguard"]);
    for (const release of gate.splice(0)) release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["unguard", "unguard"]);
    for (const release of gate.splice(0)) release();
    await Promise.all([first, second, third]);
    assert.equal(f.host.unguards, 2);
    assert.equal(events.includes("probe"), false, "the intermediate setup coalesced away");
    assert.equal(f.guard.lastResult()?.verb, "teardown");
  });
});
