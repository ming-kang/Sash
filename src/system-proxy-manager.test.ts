import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
  EnableOptions,
  LinuxSystemProxySnapshot,
  SystemProxyBackend,
  SystemProxySnapshot,
  SystemProxyState,
} from "./sysproxy.js";
import {
  parseSystemProxyJournal,
  type SystemProxyJournal,
  type SystemProxyJournalLayout,
  SystemProxyManager,
} from "./system-proxy-manager.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function linuxSnapshot(
  name: string,
  port: number,
  mode: "none" | "manual" = "none",
): LinuxSystemProxySnapshot {
  return {
    version: 1,
    platform: "linux",
    mode,
    autoConfigUrl: `${name}-auto.example.test/proxy.pac`,
    httpUseAuthentication: false,
    http: { host: `${name}-http.example.test`, port },
    https: { host: `${name}-https.example.test`, port: port + 1 },
    socks: { host: `${name}-socks.example.test`, port: port + 2 },
  };
}

function linuxCompatible(
  current: LinuxSystemProxySnapshot,
  original: LinuxSystemProxySnapshot,
  target: LinuxSystemProxySnapshot,
): boolean {
  const leaf = <T>(value: T, before: T, after: T): boolean => value === before || value === after;
  const endpoint = (
    value: { host: string; port: number },
    before: { host: string; port: number },
    after: { host: string; port: number },
  ): boolean =>
    leaf(value.host, before.host, after.host) && leaf(value.port, before.port, after.port);
  return (
    leaf(current.mode, original.mode, target.mode) &&
    leaf(current.autoConfigUrl, original.autoConfigUrl, target.autoConfigUrl) &&
    leaf(
      current.httpUseAuthentication,
      original.httpUseAuthentication,
      target.httpUseAuthentication,
    ) &&
    endpoint(current.http, original.http, target.http) &&
    endpoint(current.https, original.https, target.https) &&
    endpoint(current.socks, original.socks, target.socks)
  );
}

class FakeBackend implements SystemProxyBackend {
  readonly supported = true;
  current: LinuxSystemProxySnapshot;
  readonly applyCalls: LinuxSystemProxySnapshot[] = [];
  captureCalls = 0;
  onApply?: (snapshot: LinuxSystemProxySnapshot, backend: FakeBackend) => void;
  onCreateTarget?: (backend: FakeBackend) => void;

  constructor(initial: LinuxSystemProxySnapshot) {
    this.current = clone(initial);
  }

  capture(): SystemProxySnapshot {
    this.captureCalls++;
    return clone(this.current);
  }

  createTarget(original: SystemProxySnapshot, opts: EnableOptions): SystemProxySnapshot {
    if (original.platform !== "linux")
      throw new Error("fake backend only supports Linux snapshots");
    this.onCreateTarget?.(this);
    return {
      version: 1,
      platform: "linux",
      mode: "manual",
      autoConfigUrl: original.autoConfigUrl,
      httpUseAuthentication: false,
      http: { host: opts.host ?? "127.0.0.1", port: opts.port },
      https: { host: opts.host ?? "127.0.0.1", port: opts.port },
      socks: { host: opts.host ?? "127.0.0.1", port: opts.port },
    };
  }

  apply(snapshot: SystemProxySnapshot): void {
    if (snapshot.platform !== "linux")
      throw new Error("fake backend only supports Linux snapshots");
    const next = clone(snapshot);
    this.applyCalls.push(next);
    if (this.onApply) {
      this.onApply(next, this);
      return;
    }
    this.current = next;
  }

  equivalent(a: SystemProxySnapshot, b: SystemProxySnapshot): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  compatible(
    current: SystemProxySnapshot,
    original: SystemProxySnapshot,
    target: SystemProxySnapshot,
  ): boolean {
    if (
      current.platform !== "linux" ||
      original.platform !== "linux" ||
      target.platform !== "linux"
    ) {
      return false;
    }
    return linuxCompatible(current, original, target);
  }

  state(snapshot: SystemProxySnapshot): SystemProxyState {
    if (snapshot.platform !== "linux")
      throw new Error("fake backend only supports Linux snapshots");
    return {
      supported: true,
      enabled: snapshot.mode === "manual",
      server: `${snapshot.http.host}:${snapshot.http.port}`,
    };
  }
}

describe("SystemProxyManager", () => {
  let tmpDir: string;
  let layout: SystemProxyJournalLayout;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-system-proxy-manager-test-"));
    layout = { systemProxyStateFile: path.join(tmpDir, "state", "system-proxy.json") };
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
    original: LinuxSystemProxySnapshot,
    port = 17890,
  ): LinuxSystemProxySnapshot {
    const target = backend.createTarget(original, { port });
    assert.equal(target.platform, "linux");
    return target;
  }

  function writeJournal(
    original: LinuxSystemProxySnapshot,
    target: LinuxSystemProxySnapshot,
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

  it("upgrades legacy journals to the current in-memory schema", () => {
    const original = linuxSnapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const target = targetFor(backend, original);
    const parsed = parseSystemProxyJournal({
      schemaVersion: 1,
      phase: "applied",
      ownerPid: process.pid,
      createdAt: "2026-01-01T00:00:00.000Z",
      original,
      target,
    });

    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.phase, "applied");
  });

  it("restores an existing proxy snapshot after releasing Sash ownership", async () => {
    const original = linuxSnapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const manager = new SystemProxyManager({ layout, backend });

    await manager.apply({ port: 17890 });

    const journal = parseSystemProxyJournal(
      JSON.parse(fs.readFileSync(layout.systemProxyStateFile, "utf8")) as unknown,
    );
    assert.equal(journal.phase, "applied");
    assert.deepEqual(backend.current, targetFor(backend, original));
    assert.equal(manager.isApplied(), true);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(layout.systemProxyStateFile).mode & 0o777, 0o600);
    }

    await manager.release();

    assert.deepEqual(backend.current, original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
    assert.equal(manager.isApplied(), false);
  });

  it("does not inspect or modify the OS when recover has no journal", async () => {
    const backend = new FakeBackend(linuxSnapshot("proxy-a", 8000));
    const manager = new SystemProxyManager({ layout, backend });

    await manager.recover();

    assert.equal(backend.captureCalls, 0);
    assert.equal(backend.applyCalls.length, 0);
  });

  it("does not tear down and reapply an unchanged owned target", async () => {
    const backend = new FakeBackend(linuxSnapshot("proxy-a", 8000));
    const manager = new SystemProxyManager({ layout, backend });

    await manager.apply({ port: 17890 });
    const firstJournal = fs.readFileSync(layout.systemProxyStateFile, "utf8");
    await manager.apply({ port: 17890 });

    assert.equal(backend.applyCalls.length, 1);
    assert.equal(fs.readFileSync(layout.systemProxyStateFile, "utf8"), firstJournal);
  });

  it("refuses to overwrite an external change made while ownership is prepared", async () => {
    const original = linuxSnapshot("proxy-a", 8000);
    const external = linuxSnapshot("proxy-b", 9000);
    const backend = new FakeBackend(original);
    backend.onCreateTarget = (fake) => {
      fake.current = clone(external);
    };
    const manager = new SystemProxyManager({ layout, backend });

    await assert.rejects(manager.apply({ port: 17890 }), /changed while Sash was preparing/);

    assert.deepEqual(backend.current, external);
    assert.equal(backend.applyCalls.length, 0);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("restores a prepared partial write left by a crash", async () => {
    const original = linuxSnapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const target = targetFor(backend, original);
    const partial = clone(original);
    partial.http = clone(target.http);
    partial.https.port = target.https.port;
    backend.current = partial;
    writeJournal(original, target, "prepared");
    const manager = new SystemProxyManager({ layout, backend });

    await manager.recover();

    assert.deepEqual(backend.current, original);
    assert.equal(backend.applyCalls.length, 1);
    assert.deepEqual(backend.applyCalls[0], original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("does not treat an applied journal with one reverted field as a crash partial", async () => {
    const original = linuxSnapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const manager = new SystemProxyManager({ layout, backend });
    await manager.apply({ port: 17890 });
    backend.current.http.host = original.http.host;

    await assert.rejects(manager.release(), /modified outside Sash/);

    assert.equal(fs.existsSync(layout.systemProxyStateFile), true);
    assert.equal(backend.current.http.host, original.http.host);
    assert.equal(backend.applyCalls.length, 1);
  });

  it("fails closed when a third-party proxy configuration is present", async () => {
    const original = linuxSnapshot("proxy-a", 8000);
    const backend = new FakeBackend(linuxSnapshot("proxy-b", 9000));
    const target = targetFor(backend, original);
    const journalText = writeJournal(original, target, "applied");
    const manager = new SystemProxyManager({ layout, backend });

    await assert.rejects(manager.release(), /modified outside Sash/);

    assert.equal(backend.applyCalls.length, 0);
    assert.equal(fs.readFileSync(layout.systemProxyStateFile, "utf8"), journalText);
  });

  it("compensates an apply failure when the partial state is still compatible", async () => {
    const original = linuxSnapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const target = targetFor(backend, original);
    const partial = clone(original);
    partial.http = clone(target.http);
    let invocation = 0;
    backend.onApply = (snapshot, fake) => {
      invocation++;
      if (invocation === 1) {
        assert.deepEqual(snapshot, target);
        fake.current = clone(partial);
        throw new Error("target write failed");
      }
      assert.deepEqual(snapshot, original);
      fake.current = clone(snapshot);
    };
    const manager = new SystemProxyManager({ layout, backend });

    await assert.rejects(manager.apply({ port: 17890 }), /target write failed/);

    assert.deepEqual(backend.current, original);
    assert.equal(backend.applyCalls.length, 2);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("keeps a restoring journal when compensation cannot restore the snapshot", async () => {
    const original = linuxSnapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const target = targetFor(backend, original);
    const partial = clone(original);
    partial.http = clone(target.http);
    let invocation = 0;
    backend.onApply = (snapshot, fake) => {
      invocation++;
      if (invocation === 1) {
        assert.deepEqual(snapshot, target);
        fake.current = clone(partial);
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
    const original = linuxSnapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const manager = new SystemProxyManager({ layout, backend });
    await manager.apply({ port: 17890 });
    const target = clone(backend.current);
    const partial = clone(target);
    partial.http = clone(original.http);
    backend.onApply = (_snapshot, fake) => {
      fake.current = clone(partial);
      throw new Error("restore interrupted");
    };

    await assert.rejects(manager.release(), /restore interrupted/);
    const interrupted = parseSystemProxyJournal(
      JSON.parse(fs.readFileSync(layout.systemProxyStateFile, "utf8")) as unknown,
    );
    assert.equal(interrupted.phase, "restoring");
    assert.deepEqual(backend.current, partial);

    backend.onApply = (snapshot, fake) => {
      fake.current = clone(snapshot);
    };
    await new SystemProxyManager({ layout, backend }).recover();

    assert.deepEqual(backend.current, original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });

  it("refuses corrupt journals without overwriting or deleting them", async () => {
    const backend = new FakeBackend(linuxSnapshot("proxy-a", 8000));
    const manager = new SystemProxyManager({ layout, backend });
    const corrupt = "{ not valid JSON";
    fs.mkdirSync(path.dirname(layout.systemProxyStateFile), { recursive: true });
    fs.writeFileSync(layout.systemProxyStateFile, corrupt, { mode: 0o600 });

    await assert.rejects(manager.apply({ port: 17890 }), /journal is invalid/);
    await assert.rejects(manager.recover(), /journal is invalid/);

    assert.equal(backend.captureCalls, 0);
    assert.equal(backend.applyCalls.length, 0);
    const inspection = manager.inspect();
    assert.equal(inspection.applied, false);
    assert.equal(inspection.state.enabled, false);
    assert.match(inspection.state.details ?? "", /journal is invalid/);
    assert.equal(fs.readFileSync(layout.systemProxyStateFile, "utf8"), corrupt);
  });

  it("serializes concurrent apply and release operations", async () => {
    const original = linuxSnapshot("proxy-a", 8000);
    const backend = new FakeBackend(original);
    const events: string[] = [];
    backend.onApply = (snapshot, fake) => {
      events.push(snapshot.mode === "manual" ? "target" : "original");
      fake.current = clone(snapshot);
    };
    const manager = new SystemProxyManager({ layout, backend });

    const applying = manager.apply({ port: 17890 });
    const releasing = manager.release();
    await Promise.all([applying, releasing]);

    assert.deepEqual(events, ["target", "original"]);
    assert.deepEqual(backend.current, original);
    assert.equal(fs.existsSync(layout.systemProxyStateFile), false);
  });
});
