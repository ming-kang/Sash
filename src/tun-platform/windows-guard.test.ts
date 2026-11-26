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
  readHelperStatus,
  unguard,
}: {
  readHelperStatus?: () => Promise<HelperReply>;
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
    readHelperStatus: readHelperStatus ?? (async () => reply()),
  });
  return { guard, host };
}

describe("WindowsTunGuard setup convergence", () => {
  it("is a successful no-op when the helper speaks the guard protocol", async () => {
    const f = fixture();
    const result = await f.guard.converge("setup");
    assert.equal(f.host.unguards, 0);
    assert.equal(result, f.guard.lastResult());
    assert.equal(result?.state, "ok");
    assert.equal(result?.verb, "setup");
  });

  it("reports a protocol-1 helper as unavailable instead of pretending convergence", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    const f = fixture({ readHelperStatus: async () => reply({ protocol: 1 }) });
    await f.guard.converge("setup");
    const result = f.guard.lastResult();
    assert.equal(result?.state, "unavailable");
    assert.match(result?.detail ?? "", /protocol 1/);
    assert.match(result?.detail ?? "", /sash tun helper install/);
    assert.equal(warnings.length, 1);
  });

  it("reports a missing helper as unavailable", async () => {
    const f = fixture({
      readHelperStatus: async () => {
        throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
      },
    });
    await f.guard.converge("setup");
    const result = f.guard.lastResult();
    assert.equal(result?.state, "unavailable");
    assert.match(result?.detail ?? "", /unreachable/);
  });

  it("reports an unexpected probe failure as failed without rejecting", async () => {
    const f = fixture({
      readHelperStatus: async () => {
        throw new Error("pipe timed out");
      },
    });
    await f.guard.converge("setup");
    const result = f.guard.lastResult();
    assert.equal(result?.state, "failed");
    assert.match(result?.detail ?? "", /pipe timed out/);
  });
});

describe("WindowsTunGuard teardown convergence", () => {
  it("calls the host unguard operation and records success", async () => {
    const f = fixture();
    await f.guard.converge("teardown");
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
    await f.guard.converge("teardown");
    const result = f.guard.lastResult();
    assert.equal(f.host.unguards, 1);
    assert.equal(result?.state, "failed");
    assert.match(result?.detail ?? "", /pipe busy/);
  });

  it("classifies a protocol-1 unguard failure for doctor", async () => {
    const f = fixture({
      readHelperStatus: async () => reply({ protocol: 1 }),
      unguard: async () => {
        throw new Error(`unknown op "unguard"`);
      },
    });
    await f.guard.converge("teardown");
    const result = f.guard.lastResult();
    assert.equal(result?.state, "unavailable");
    assert.match(result?.detail ?? "", /protocol 1/);
    assert.match(result?.detail ?? "", /sash tun helper install/);
  });
});

describe("WindowsTunGuard status reads", () => {
  it("reads fresh helper state without replacing the cached convergence result", async () => {
    let active = false;
    const f = fixture({
      readHelperStatus: async () =>
        reply({ guard: { active, device: "sashtun", interfaceIndex: 17 } }),
    });
    await f.guard.converge("setup");
    const cached = f.guard.lastResult();

    active = true;
    assert.deepEqual(await f.guard.readFreshStatus(), {
      supported: true,
      active: true,
      device: "sashtun",
      interfaceIndex: 17,
      detail: null,
    });
    assert.equal(f.guard.lastResult(), cached);
    assert.equal(cached?.verb, "setup");
  });

  it("reports an unsupported helper for interactive reads", async () => {
    const f = fixture({ readHelperStatus: async () => reply({ protocol: 1 }) });
    const status = await f.guard.readFreshStatus();
    assert.equal(status.supported, false);
    assert.equal(status.active, false);
    assert.match(status.detail ?? "", /protocol 1/);
    assert.equal(f.guard.lastResult(), undefined);
  });
});

describe("WindowsTunGuard serialization", () => {
  it("never overlaps operations and coalesces queued convergences to the latest state", async () => {
    const gate: Array<() => void> = [];
    const events: string[] = [];
    const f = fixture({
      readHelperStatus: async () => {
        events.push("probe");
        return reply();
      },
      unguard: async () => {
        events.push("unguard");
        await new Promise<void>((resolve) => gate.push(resolve));
      },
    });
    const first = f.guard.converge("teardown");
    const second = f.guard.converge("setup");
    const third = f.guard.converge("teardown");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["unguard"]);
    for (const release of gate.splice(0)) release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["unguard", "unguard"]);
    for (const release of gate.splice(0)) release();
    const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);
    assert.equal(f.host.unguards, 2);
    assert.equal(events.includes("probe"), false, "the intermediate setup coalesced away");
    assert.equal(firstResult?.verb, "teardown");
    assert.equal(
      secondResult?.verb,
      "teardown",
      "the superseded setup reports the teardown that ran",
    );
    assert.equal(thirdResult?.verb, "teardown");
    assert.equal(f.guard.lastResult()?.verb, "teardown");
  });
});
