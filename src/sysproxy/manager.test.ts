import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { deferred } from "../testing/state.js";
import { createSystemProxyBackend } from "./index.js";
import {
  type SystemProxyJournal,
  type SystemProxyJournalLayout,
  SystemProxyManager,
} from "./manager.js";
import type {
  SystemProxyBackend,
  SystemProxyRestoreSkip,
  SystemProxySnapshot,
  WindowsSystemProxySnapshot,
} from "./types.js";
import {
  asWindowsSnapshot,
  createWindowsTarget,
  windowsSystemProxySnapshotCodec,
} from "./windows.js";

function snapshot(name: string, port: number): WindowsSystemProxySnapshot {
  return {
    version: 1,
    platform: "win32",
    proxyEnable: 0,
    proxyServer: `${name}.example.test:${port}`,
    proxyOverride: "<local>",
    autoConfigUrl: `https://${name}.example.test/proxy.pac`,
    autoDetect: 1,
    connections: {},
  };
}

const FAKE_MANAGED_KEYS = [
  "proxyEnable",
  "proxyServer",
  "proxyOverride",
  "autoConfigUrl",
  "autoDetect",
  "connections",
] as const;

class FakeBackend implements SystemProxyBackend {
  readonly supported = true;
  readonly snapshot = windowsSystemProxySnapshotCodec;
  current: WindowsSystemProxySnapshot;
  readonly applyCalls: WindowsSystemProxySnapshot[] = [];
  captureCalls = 0;
  onApply?: (snapshot: WindowsSystemProxySnapshot, backend: FakeBackend) => void | Promise<void>;
  onCapture?: (backend: FakeBackend) => void | Promise<void>;
  constructor(initial: WindowsSystemProxySnapshot) {
    this.current = structuredClone(initial);
  }
  async capture(): Promise<SystemProxySnapshot> {
    this.captureCalls++;
    await this.onCapture?.(this);
    return structuredClone(this.current);
  }
  async apply(snapshot: SystemProxySnapshot): Promise<void> {
    const next = structuredClone(asWindowsSnapshot(snapshot));
    this.applyCalls.push(next);
    if (this.onApply) await this.onApply(next, this);
    else this.current = next;
  }
  // Flat-field restore: write back each recorded original still holding
  // Sash's target, skip fields changed outside Sash, then verify by capture.
  async restore(
    original: SystemProxySnapshot,
    target: SystemProxySnapshot,
  ): Promise<{ skipped: SystemProxyRestoreSkip[] }> {
    const o = asWindowsSnapshot(original) as unknown as Record<string, unknown>;
    const t = asWindowsSnapshot(target) as unknown as Record<string, unknown>;
    const cur = asWindowsSnapshot(await this.capture()) as unknown as Record<string, unknown>;
    const skipped: SystemProxyRestoreSkip[] = [];
    const writes: string[] = [];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const key of FAKE_MANAGED_KEYS) {
      if (same(cur[key], o[key])) continue;
      if (same(cur[key], t[key])) writes.push(key);
      else skipped.push({ key, service: "Internet Settings", reason: "modified" });
    }
    if (writes.length === 0) return { skipped };
    const next = structuredClone(cur);
    for (const key of writes) next[key] = structuredClone(o[key]);
    await this.apply(next as unknown as WindowsSystemProxySnapshot);
    const after = asWindowsSnapshot(await this.capture()) as unknown as Record<string, unknown>;
    for (const key of writes) {
      if (!same(after[key], o[key])) {
        skipped.push({ key, service: "Internet Settings", reason: "modified" });
      }
    }
    return { skipped };
  }
}

describe("SystemProxyManager", () => {
  let tmpDir: string;
  let layout: SystemProxyJournalLayout;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-sysproxy-manager-test-"));
    layout = {
      systemProxyStateFile: path.join(tmpDir, "state", "system-proxy.json"),
      systemProxyLockFile: path.join(tmpDir, "proxy.lock"),
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function writeJournal(
    original: SystemProxySnapshot,
    target: SystemProxySnapshot,
    phase: SystemProxyJournal["phase"] | "restoring" = "prepared",
  ): string {
    const journal = {
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

  function readJournal(): SystemProxyJournal {
    return JSON.parse(fs.readFileSync(layout.systemProxyStateFile, "utf8")) as SystemProxyJournal;
  }

  it("restores an existing proxy snapshot after releasing Sash ownership", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const manager = new SystemProxyManager({ layout, backend });

    await manager.apply({ port: 17890 });

    assert.equal(readJournal().phase, "applied");
    assert.deepEqual(backend.current, createWindowsTarget({ port: 17890 }, original));
    assert.equal((await manager.inspect()).applied, true);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(layout.systemProxyStateFile).mode & 0o777, 0o600);
    }

    await manager.release();

    assert.deepEqual(backend.current, original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
    assert.equal((await manager.inspect()).applied, false);
  });

  it("delegates platform-specific snapshots and durable restoration to the backend codec", async () => {
    const original: SystemProxySnapshot = { version: 1, platform: "darwin", values: { port: 0 } };
    let current: SystemProxySnapshot = original;
    const backend: SystemProxyBackend = {
      supported: true,
      capture: async () => current,
      apply: async (value) => {
        current = value;
      },
      snapshot: {
        parse(value) {
          assert.equal((value as SystemProxySnapshot).platform, "darwin");
          return value as SystemProxySnapshot;
        },
        equivalent: (a, b) => JSON.stringify(a) === JSON.stringify(b),
        target: ({ port }) => ({ version: 1, platform: "darwin", values: { port } }),
        state: (value) => ({
          supported: true,
          enabled: value.platform === "darwin" && value.values.port !== 0,
        }),
      },
      restore: async (original) => {
        current = original;
        return { skipped: [] };
      },
    };
    const manager = new SystemProxyManager({ layout, backend });
    await manager.apply({ port: 7890 });
    const reopened = new SystemProxyManager({ layout, backend });
    assert.equal((await reopened.inspect()).applied, true);
    await reopened.release();
    assert.deepEqual(current, original);
  });

  it("rejects old and malformed journal formats without migrating them", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const valid: SystemProxyJournal = {
      schemaVersion: 2,
      phase: "applied",
      ownerPid: process.pid,
      createdAt: "2026-09-08T00:00:00.000Z",
      original,
      target: createWindowsTarget({ port: 17890 }),
    };
    const manager = new SystemProxyManager({ layout, backend });
    for (const invalid of [
      { ...valid, schemaVersion: 1 },
      { ...valid, extra: true },
      { ...valid, ownerPid: 0 },
      { ...valid, original: { ...original, extra: true } },
    ]) {
      fs.mkdirSync(path.dirname(layout.systemProxyStateFile), { recursive: true });
      const text = JSON.stringify(invalid);
      fs.writeFileSync(layout.systemProxyStateFile, text, { mode: 0o600 });
      await assert.rejects(manager.release(), /journal is invalid/);
      assert.equal(fs.readFileSync(layout.systemProxyStateFile, "utf8"), text, "left untouched");
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
    const backend = createSystemProxyBackend("freebsd" as NodeJS.Platform);
    const manager = new SystemProxyManager({ layout, backend });
    const inspection = await manager.inspect();
    assert.deepEqual(inspection.state, {
      supported: false,
      enabled: false,
      details: "System proxy integration is not available on this platform",
    });
    assert.equal(inspection.stateKnown, true);
    assert.equal(inspection.applied, false);
    await assert.rejects(
      manager.apply({ port: 17890 }),
      /System proxy integration is not available on this platform/,
    );
    await assert.rejects(
      backend.apply(createWindowsTarget({ port: 17890 })),
      /System proxy integration is not available on this platform/,
    );
    await assert.rejects(
      backend.restore(createWindowsTarget({ port: 17890 }), createWindowsTarget({ port: 17890 })),
      /System proxy integration is not available on this platform/,
    );
    await manager.release();
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
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
    backend.onCapture = (fake) => {
      if (fake.captureCalls === 2) fake.current = structuredClone(external);
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
    const target = createWindowsTarget({ port: 17890 }, original);
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

  it("restores the remaining target fields when one already matches the original", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const manager = new SystemProxyManager({ layout, backend });
    await manager.apply({ port: 17890 });
    backend.current.proxyServer = original.proxyServer;

    await manager.release();

    assert.deepEqual(backend.current, original);
    assert.equal(backend.applyCalls.length, 2);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("fails closed when a third-party proxy configuration is present", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(snapshot("proxy-b", 9000));
    const target = createWindowsTarget({ port: 17890 });
    const journalText = writeJournal(original, target, "applied");
    const manager = new SystemProxyManager({ layout, backend });

    await assert.rejects(manager.release(), /modified outside Sash/);

    assert.equal(backend.applyCalls.length, 0);
    assert.equal(fs.readFileSync(layout.systemProxyStateFile, "utf8"), journalText);
  });

  it("compensates an apply failure when the partial state is still compatible", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const target = createWindowsTarget({ port: 17890 }, original);
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

  it("keeps the journal when compensation cannot restore the snapshot", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const target = createWindowsTarget({ port: 17890 }, original);
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

    assert.equal(readJournal().phase, "prepared");
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
    assert.equal(readJournal().phase, "applied");
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

  it("reuses a settled non-fresh inspection cache and always captures when fresh", async () => {
    const backend = new FakeBackend(snapshot("proxy-a", 8000));
    const manager = new SystemProxyManager({ layout, backend });

    await manager.inspect();
    assert.equal(backend.captureCalls, 1);
    await manager.inspect();
    assert.equal(backend.captureCalls, 1, "non-fresh reads reuse the settled cache");
    await manager.inspect(true);
    assert.equal(backend.captureCalls, 2, "fresh reads bypass the cache");
    await manager.inspect();
    assert.equal(backend.captureCalls, 2, "subsequent non-fresh reads reuse the updated cache");
  });

  it("serializes concurrent inspections behind one capture", async () => {
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
    release.resolve();
    const [a, b] = await Promise.all([first, second]);

    assert.deepEqual(a, b);
    assert.equal(backend.captureCalls, 1, "the queued read is served from the settled cache");
  });

  it("serializes inspection behind an in-flight write", async () => {
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
    const inspecting = manager.inspect(true);
    const releasing = manager.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["target"], "inspection waits for the pending write");

    releaseApply.resolve();
    await applying;
    const observed = await inspecting;
    await releasing;

    assert.equal(observed.applied, true, "inspection observed the applied target");
    assert.equal(observed.appliedKnown, true);
    assert.equal(observed.stateKnown, true);
    assert.deepEqual(events, ["target", "original"]);
    assert.deepEqual(backend.current, original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("tolerates a journal removed during verified restoration", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const manager = new SystemProxyManager({ layout, backend });
    await manager.apply({ port: 17890 });
    let captures = 0;
    backend.onCapture = () => {
      captures += 1;
      if (captures === 2) fs.rmSync(layout.systemProxyStateFile);
    };

    await manager.release();

    assert.deepEqual(backend.current, original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("propagates falsy restoration write failures and keeps the journal", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const manager = new SystemProxyManager({ layout, backend });
    await manager.apply({ port: 17890 });
    backend.onApply = (snapshot, fake) => {
      fake.current = structuredClone(snapshot);
      return Promise.reject(undefined);
    };

    await assert.rejects(manager.release());
    assert.equal(fs.existsSync(layout.systemProxyStateFile), true);
  });

  it("recovers a legacy journal left in the restoring phase", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const target = createWindowsTarget({ port: 17890 }, original);
    backend.current = structuredClone(target);
    writeJournal(original, target, "restoring");
    const manager = new SystemProxyManager({ layout, backend });

    assert.equal((await manager.inspect()).applied, false);
    await manager.release();

    assert.deepEqual(backend.current, original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("recovers a legacy restoring journal left mid-write in a partial state", async () => {
    const original = snapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const target = createWindowsTarget({ port: 17890 }, original);
    const partial = structuredClone(target);
    partial.proxyServer = original.proxyServer;
    backend.current = partial;
    writeJournal(original, target, "restoring");
    const manager = new SystemProxyManager({ layout, backend });

    await manager.release();

    assert.deepEqual(backend.current, original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
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
    assert.equal((await queued.inspect()).applied, true);
  });
});
