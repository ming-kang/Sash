import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createSystemProxyBackend,
  type EnableOptions,
  type SystemProxyBackend,
  type SystemProxySnapshot,
  type SystemProxyState,
} from "./sysproxy.js";
import {
  parseSystemProxyJournal,
  type SystemProxyJournal,
  type SystemProxyJournalLayout,
  SystemProxyManager,
} from "./system-proxy-manager.js";
import { deferred } from "./test-state.test.js";

const windows = createSystemProxyBackend("win32");
function snapshot(name: string, port: number): SystemProxySnapshot {
  return {
    version: 1,
    platform: "win32",
    proxyEnable: 0,
    proxyServer: `${name}.example.test:${port}`,
    proxyOverride: "<local>",
    autoConfigUrl: `https://${name}.example.test/proxy.pac`,
    autoDetect: 1,
  };
}

class FakeBackend implements SystemProxyBackend {
  readonly supported = true;
  current: SystemProxySnapshot;
  readonly applyCalls: SystemProxySnapshot[] = [];
  captureCalls = 0;
  onApply?: (snapshot: SystemProxySnapshot, backend: FakeBackend) => void | Promise<void>;
  onCapture?: (backend: FakeBackend) => void | Promise<void>;
  onCreateTarget?: (backend: FakeBackend) => void;
  constructor(initial: SystemProxySnapshot) {
    this.current = structuredClone(initial);
  }
  async capture(): Promise<SystemProxySnapshot> {
    this.captureCalls++;
    await this.onCapture?.(this);
    return structuredClone(this.current);
  }
  createTarget(original: SystemProxySnapshot, opts: EnableOptions): SystemProxySnapshot {
    this.onCreateTarget?.(this);
    return windows.createTarget(original, opts);
  }
  async apply(snapshot: SystemProxySnapshot): Promise<void> {
    const next = structuredClone(snapshot);
    this.applyCalls.push(next);
    if (this.onApply) await this.onApply(next, this);
    else this.current = next;
  }
  equivalent = windows.equivalent;
  compatible = windows.compatible;
  state(snapshot: SystemProxySnapshot): SystemProxyState {
    return windows.state(snapshot);
  }
}

describe("SystemProxyManager", () => {
  let tmpDir: string;
  let layout: SystemProxyJournalLayout;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-system-proxy-manager-test-"));
    layout = {
      systemProxyStateFile: path.join(tmpDir, "state", "system-proxy.json"),
      systemProxyLockFile: path.join(tmpDir, "proxy.lock"),
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  });

  function targetFor(
    backend: FakeBackend,
    original: SystemProxySnapshot,
    port = 17890,
  ): SystemProxySnapshot {
    const target = backend.createTarget(original, { port });
    assert.equal(target.platform, "win32");
    return target;
  }

  function writeJournal(
    original: SystemProxySnapshot,
    target: SystemProxySnapshot,
    phase: SystemProxyJournal["phase"] = "prepared",
  ): string {
    const journal: SystemProxyJournal = {
      schemaVersion: 2,
      phase,
      ownerPid: process.pid,
      createdAt: "2026-01-01T00:00:00.000Z",
      original,
      target,
    };
    const text = `${JSON.stringify(journal, null, 2)}\n`;
    fs.mkdirSync(path.dirname(layout.systemProxyStateFile), { recursive: true });
    fs.writeFileSync(layout.systemProxyStateFile, text, { mode: 0o600 });
    return text;
  }

  it("restores an existing proxy snapshot after releasing Sash ownership", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const manager = new SystemProxyManager({ layout, backend });

    await manager.apply({ port: 17890 });

    const journal = parseSystemProxyJournal(
      JSON.parse(fs.readFileSync(layout.systemProxyStateFile, "utf8")) as unknown,
    );
    assert.equal(journal.phase, "applied");
    assert.deepEqual(backend.current, targetFor(backend, original));
    assert.equal(await manager.isApplied(), true);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(layout.systemProxyStateFile).mode & 0o777, 0o600);
    }

    await manager.release();

    assert.deepEqual(backend.current, original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
    assert.equal(await manager.isApplied(), false);
  });

  it("rejects old and malformed journal formats without migrating them", () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const valid: SystemProxyJournal = {
      schemaVersion: 2,
      phase: "applied",
      ownerPid: process.pid,
      createdAt: "2026-09-08T00:00:00.000Z",
      original,
      target: targetFor(backend, original),
    };
    for (const invalid of [
      { ...valid, schemaVersion: 1 },
      { ...valid, extra: true },
      { ...valid, ownerPid: 0 },
      { ...valid, original: { ...original, extra: true } },
    ]) {
      assert.throws(() => parseSystemProxyJournal(invalid), /Invalid system proxy journal/);
    }
  });

  it("serializes two managers through their shared OS operation lock", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const entered = deferred();
    const release = deferred();
    backend.onApply = async (value, fake) => {
      if (value.proxyEnable === 1) {
        entered.resolve();
        await release.promise;
      }
      fake.current = structuredClone(value);
    };
    const owner = new SystemProxyManager({ layout, backend });
    const recovery = new SystemProxyManager({ layout, backend });
    const applying = owner.apply({ port: 17890 });
    await entered.promise;
    const restoring = recovery.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(backend.applyCalls.length, 1);
    release.resolve();
    await Promise.all([applying, restoring]);
    assert.deepEqual(backend.current, original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("does not inspect or modify the OS when release has no journal", async () => {
    const backend = new FakeBackend(snapshot("proxy-a", 8000));
    const manager = new SystemProxyManager({ layout, backend });

    await manager.release();

    assert.equal(backend.captureCalls, 0);
    assert.equal(backend.applyCalls.length, 0);
  });

  it("reports unsupported desktop integration without issuing OS commands", async () => {
    const manager = new SystemProxyManager({ layout, backend: createSystemProxyBackend("linux") });
    const inspection = await manager.inspect();
    assert.equal(inspection.state.supported, false);
    assert.equal(inspection.stateKnown, true);
    assert.equal(inspection.applied, false);
    await manager.release();
  });

  it("does not tear down and reapply an unchanged owned target", async () => {
    const backend = new FakeBackend(snapshot("proxy-a", 8000));
    const manager = new SystemProxyManager({ layout, backend });

    await manager.apply({ port: 17890 });
    const firstJournal = fs.readFileSync(layout.systemProxyStateFile, "utf8");
    await manager.apply({ port: 17890 });

    assert.equal(backend.applyCalls.length, 1);
    assert.equal(fs.readFileSync(layout.systemProxyStateFile, "utf8"), firstJournal);
  });

  it("refuses to overwrite an external change made while ownership is prepared", async () => {
    const original = snapshot("proxy-a", 8000);
    const external = snapshot("proxy-b", 9000);
    const backend = new FakeBackend(original);
    backend.onCreateTarget = (fake) => {
      fake.current = structuredClone(external);
    };
    const manager = new SystemProxyManager({ layout, backend });

    await assert.rejects(manager.apply({ port: 17890 }), /changed while Sash was preparing/);

    assert.deepEqual(backend.current, external);
    assert.equal(backend.applyCalls.length, 0);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("restores a prepared partial write left by a crash", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const target = targetFor(backend, original);
    const partial = structuredClone(original);
    partial.proxyServer = target.proxyServer;
    partial.proxyEnable = target.proxyEnable;
    backend.current = partial;
    writeJournal(original, target, "prepared");
    const manager = new SystemProxyManager({ layout, backend });

    await manager.release();

    assert.deepEqual(backend.current, original);
    assert.equal(backend.applyCalls.length, 1);
    assert.deepEqual(backend.applyCalls[0], original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("does not treat an applied journal with one reverted field as a crash partial", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const manager = new SystemProxyManager({ layout, backend });
    await manager.apply({ port: 17890 });
    backend.current.proxyServer = original.proxyServer;

    await assert.rejects(manager.release(), /modified outside Sash/);

    assert.equal(fs.existsSync(layout.systemProxyStateFile), true);
    assert.equal(backend.current.proxyServer, original.proxyServer);
    assert.equal(backend.applyCalls.length, 1);
  });

  it("fails closed when a third-party proxy configuration is present", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(snapshot("proxy-b", 9000));
    const target = targetFor(backend, original);
    const journalText = writeJournal(original, target, "applied");
    const manager = new SystemProxyManager({ layout, backend });

    await assert.rejects(manager.release(), /modified outside Sash/);

    assert.equal(backend.applyCalls.length, 0);
    assert.equal(fs.readFileSync(layout.systemProxyStateFile, "utf8"), journalText);
  });

  it("compensates an apply failure when the partial state is still compatible", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const target = targetFor(backend, original);
    const partial = structuredClone(original);
    partial.proxyServer = target.proxyServer;
    let invocation = 0;
    backend.onApply = (snapshot, fake) => {
      invocation++;
      if (invocation === 1) {
        assert.deepEqual(snapshot, target);
        fake.current = structuredClone(partial);
        throw new Error("target write failed");
      }
      assert.deepEqual(snapshot, original);
      fake.current = structuredClone(snapshot);
    };
    const manager = new SystemProxyManager({ layout, backend });

    await assert.rejects(manager.apply({ port: 17890 }), /target write failed/);

    assert.deepEqual(backend.current, original);
    assert.equal(backend.applyCalls.length, 2);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("keeps a restoring journal when compensation cannot restore the snapshot", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const target = targetFor(backend, original);
    const partial = structuredClone(original);
    partial.proxyServer = target.proxyServer;
    let invocation = 0;
    backend.onApply = (snapshot, fake) => {
      invocation++;
      if (invocation === 1) {
        assert.deepEqual(snapshot, target);
        fake.current = structuredClone(partial);
        throw new Error("target write failed");
      }
      assert.deepEqual(snapshot, original);
      throw new Error("restore write failed");
    };
    const manager = new SystemProxyManager({ layout, backend });

    await assert.rejects(
      manager.apply({ port: 17890 }),
      /target write failed; conditional restoration failed: restore write failed/,
    );

    const journal = parseSystemProxyJournal(
      JSON.parse(fs.readFileSync(layout.systemProxyStateFile, "utf8")) as unknown,
    );
    assert.equal(journal.phase, "restoring");
    assert.deepEqual(backend.current, partial);
  });

  it("continues a partial restoration after a crash", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const manager = new SystemProxyManager({ layout, backend });
    await manager.apply({ port: 17890 });
    const target = structuredClone(backend.current);
    const partial = structuredClone(target);
    partial.proxyServer = original.proxyServer;
    backend.onApply = (_snapshot, fake) => {
      fake.current = structuredClone(partial);
      throw new Error("restore interrupted");
    };

    await assert.rejects(manager.release(), /restore interrupted/);
    const interrupted = parseSystemProxyJournal(
      JSON.parse(fs.readFileSync(layout.systemProxyStateFile, "utf8")) as unknown,
    );
    assert.equal(interrupted.phase, "restoring");
    assert.deepEqual(backend.current, partial);

    backend.onApply = (snapshot, fake) => {
      fake.current = structuredClone(snapshot);
    };
    await new SystemProxyManager({ layout, backend }).release();

    assert.deepEqual(backend.current, original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("refuses corrupt journals without overwriting or deleting them", async () => {
    const backend = new FakeBackend(snapshot("proxy-a", 8000));
    const manager = new SystemProxyManager({ layout, backend });
    const corrupt = "{ not valid JSON";
    fs.mkdirSync(path.dirname(layout.systemProxyStateFile), { recursive: true });
    fs.writeFileSync(layout.systemProxyStateFile, corrupt, { mode: 0o600 });

    await assert.rejects(manager.apply({ port: 17890 }), /journal is invalid/);
    await assert.rejects(manager.release(), /journal is invalid/);

    assert.equal(backend.captureCalls, 0);
    assert.equal(backend.applyCalls.length, 0);
    const inspection = await manager.inspect();
    assert.equal(inspection.applied, false);
    assert.equal(inspection.appliedKnown, false);
    assert.equal(inspection.stateKnown, true);
    assert.match(inspection.queryError ?? "", /journal is invalid/);
    assert.equal(inspection.state.enabled, true);
    assert.match(inspection.state.details ?? "", /journal is invalid/);
    assert.equal(fs.readFileSync(layout.systemProxyStateFile, "utf8"), corrupt);
  });

  it("deduplicates same-generation inspections and reuses only settled non-fresh cache", async () => {
    const backend = new FakeBackend(snapshot("proxy-a", 8000));
    const entered = deferred();
    const release = deferred();
    let blockFirst = true;
    backend.onCapture = async () => {
      if (!blockFirst) return;
      blockFirst = false;
      entered.resolve();
      await release.promise;
    };
    const manager = new SystemProxyManager({ layout, backend });

    const first = manager.inspect();
    await entered.promise;
    const second = manager.inspect();
    const freshWhilePending = manager.inspect(true);
    assert.equal(second, first);
    assert.equal(freshWhilePending, first);
    release.resolve();
    await Promise.all([first, second, freshWhilePending]);
    assert.equal(backend.captureCalls, 1);

    await manager.inspect();
    assert.equal(backend.captureCalls, 1);
    await manager.inspect(true);
    assert.equal(backend.captureCalls, 2);
  });

  it("keeps inspection responsive with unknown state while serializing OS writes", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const events: string[] = [];
    const applyEntered = deferred();
    const releaseApply = deferred();
    backend.onApply = async (snapshot, fake) => {
      events.push(snapshot.proxyEnable === 1 ? "target" : "original");
      if (snapshot.proxyEnable === 1) {
        applyEntered.resolve();
        await releaseApply.promise;
      }
      fake.current = structuredClone(snapshot);
    };
    const manager = new SystemProxyManager({ layout, backend });

    const applying = manager.apply({ port: 17890 });
    await applyEntered.promise;
    const inspecting = manager.inspect();
    const releasing = manager.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["target"]);

    releaseApply.resolve();
    await applying;
    const observed = await inspecting;
    await releasing;

    assert.equal(observed.appliedKnown, false);
    assert.equal(observed.stateKnown, false);
    assert.match(observed.queryError ?? "", /in progress/);
    assert.deepEqual(events, ["target", "original"]);
    assert.deepEqual(backend.current, original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("retries inspection when another manager removes the journal during capture", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const owner = new SystemProxyManager({ layout, backend });
    await owner.apply({ port: 17890 });
    const baseline = backend.captureCalls;
    backend.onCapture = () => {
      if (backend.captureCalls === baseline + 1) {
        fs.rmSync(layout.systemProxyStateFile);
      }
    };
    const observer = new SystemProxyManager({ layout, backend });

    const inspection = await observer.inspect(true);

    assert.equal(backend.captureCalls, baseline + 2);
    assert.equal(inspection.applied, false);
    assert.equal(inspection.appliedKnown, true);
    assert.equal(inspection.stateKnown, true);
    assert.equal(inspection.state.enabled, true);
    await observer.inspect();
    assert.equal(backend.captureCalls, baseline + 2);
  });

  it("reports expected-journal disappearance during verified restoration", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const manager = new SystemProxyManager({ layout, backend });
    await manager.apply({ port: 17890 });
    let captures = 0;
    backend.onCapture = () => {
      captures += 1;
      if (captures === 2) fs.rmSync(layout.systemProxyStateFile);
    };

    await assert.rejects(manager.release(), /journal changed while restoring/);

    assert.deepEqual(backend.current, original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("preserves falsy restoration failures unless fresh verification proves success", async () => {
    const original = snapshot("proxy-a", 8000);
    const verifiedBackend = new FakeBackend(original);
    const verified = new SystemProxyManager({ layout, backend: verifiedBackend });
    await verified.apply({ port: 17890 });
    verifiedBackend.onApply = (snapshot, fake) => {
      fake.current = structuredClone(snapshot);
      return Promise.reject(undefined);
    };

    await verified.release();
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);

    const failedLayout = {
      ...layout,
      systemProxyStateFile: path.join(tmpDir, "state", "system-proxy-failed.json"),
    };
    const failedBackend = new FakeBackend(original);
    const failed = new SystemProxyManager({ layout: failedLayout, backend: failedBackend });
    await failed.apply({ port: 17890 });
    failedBackend.onApply = () => Promise.reject(undefined);

    await assert.rejects(
      failed.release(),
      /undefined; conditional restoration failed: System proxy restoration verification failed/,
    );
  });

  it("reports falsy capture failures and continues the queue after a falsy rejection", async () => {
    const original = snapshot("proxy-a", 8000);
    const captureBackend = new FakeBackend(original);
    captureBackend.onCapture = () => Promise.reject(undefined);
    const observing = new SystemProxyManager({ layout, backend: captureBackend });

    const inspection = await observing.inspect(true);
    assert.equal(inspection.appliedKnown, false);
    assert.equal(inspection.stateKnown, false);
    assert.equal(inspection.queryError, "undefined");

    const queuedLayout = {
      ...layout,
      systemProxyStateFile: path.join(tmpDir, "state", "system-proxy-queued.json"),
    };
    const queuedBackend = new FakeBackend(original);
    let rejectTarget = true;
    queuedBackend.onApply = (snapshot, fake) => {
      fake.current = structuredClone(snapshot);
      if (rejectTarget) {
        rejectTarget = false;
        return Promise.reject(undefined);
      }
    };
    const queued = new SystemProxyManager({ layout: queuedLayout, backend: queuedBackend });

    await assert.rejects(queued.apply({ port: 17890 }));
    await queued.apply({ port: 17890 });
    assert.equal(await queued.isApplied(), true);
  });
});
