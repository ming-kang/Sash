import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { evaluateDaemon, spawnDaemon, stopDaemonFromCli } from "./daemon-lifecycle.js";
import { sashLayout } from "./paths.js";
import { DEFAULT_SETTINGS, saveSettings } from "./settings.js";
import { acquireStateLockSync, type StateLockRecord } from "./state-lock.js";

describe("daemon ownership evaluation", () => {
  let root: string;
  let server: http.Server | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-daemon-lifecycle-test-"));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("treats a live singleton lease without a PID record as a starting daemon", async () => {
    const layout = sashLayout(root);
    const lease = acquireStateLockSync(layout.daemonLeaseFile, { purpose: "test sashd" });
    try {
      const state = await evaluateDaemon(layout, { ...DEFAULT_SETTINGS });
      assert.deepEqual(state, {
        running: true,
        healthy: false,
        pid: process.pid,
      });
    } finally {
      lease.release();
    }
  });

  it("fails closed when the singleton lease is corrupt", async () => {
    const layout = sashLayout(root);
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.daemonLeaseFile, "{ broken");

    const state = await evaluateDaemon(layout, { ...DEFAULT_SETTINGS });

    assert.equal(state.running, true);
    assert.equal(state.healthy, false);
  });

  it("reports a dead singleton lease as stale rather than running", async () => {
    const layout = sashLayout(root);
    const dead: StateLockRecord = {
      version: 1,
      pid: 2_147_483_647,
      token: "dead-daemon-token",
      purpose: "dead sashd",
      acquiredAt: "2026-01-01T00:00:00.000Z",
    };
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.daemonLeaseFile, `${JSON.stringify(dead)}\n`);

    const state = await evaluateDaemon(layout, { ...DEFAULT_SETTINGS });

    assert.deepEqual(state, {
      running: false,
      staleLeaseFile: true,
      pid: dead.pid,
    });
  });

  it("fails closed for a live legacy PID that cannot prove daemon health", async () => {
    const layout = sashLayout(root);
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(
      layout.daemonPidFile,
      `${JSON.stringify({
        pid: process.pid,
        token: "stale-token",
        port: 19090,
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    const state = await evaluateDaemon(layout, { ...DEFAULT_SETTINGS });

    assert.equal(state.running, true);
    assert.equal(state.healthy, false);
    assert.equal(state.legacyOwnership, true);
    assert.equal(state.pid, process.pid);
  });

  it("recognizes a healthy pre-lease daemon only through matching PID and boot token", async () => {
    const layout = sashLayout(root);
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          token: "legacy-token",
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(
      layout.daemonPidFile,
      `${JSON.stringify({
        pid: process.pid,
        token: "legacy-token",
        port,
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    const state = await evaluateDaemon(layout, {
      ...DEFAULT_SETTINGS,
      daemonPort: port,
      daemonSecret: "test-secret",
    });

    assert.equal(state.running, true);
    assert.equal(state.healthy, true);
    assert.equal(state.legacyOwnership, true);
    assert.equal(state.pid, process.pid);
  });

  it("does not mark a live PID safe to replace when its health token mismatches", async () => {
    const layout = sashLayout(root);
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          token: "different-token",
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(
      layout.daemonPidFile,
      `${JSON.stringify({
        pid: process.pid,
        token: "expected-token",
        port,
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    const lease = acquireStateLockSync(layout.daemonLeaseFile, { purpose: "test sashd" });
    const state = await evaluateDaemon(layout, {
      ...DEFAULT_SETTINGS,
      daemonPort: port,
      daemonSecret: "test-secret",
    });
    lease.release();

    assert.equal(state.running, true);
    assert.equal(state.healthy, false);
    assert.equal(state.stalePidFile, true);
    assert.equal(state.pid, process.pid);
  });

  it("refuses to stop a leased daemon when the boot token no longer matches", async () => {
    const layout = sashLayout(root);
    let shutdownRequests = 0;
    server = http.createServer((req, res) => {
      if (req.url === "/sash/shutdown") shutdownRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          token: "successor-token",
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(
      layout.daemonPidFile,
      `${JSON.stringify({
        pid: process.pid,
        token: "expected-token",
        port,
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const lease = acquireStateLockSync(layout.daemonLeaseFile, { purpose: "test sashd" });

    try {
      const stopped = await stopDaemonFromCli({
        layout,
        settings: { ...DEFAULT_SETTINGS, daemonPort: port, daemonSecret: "test-secret" },
      });
      assert.equal(stopped, false);
      assert.equal(shutdownRequests, 0);
    } finally {
      lease.release();
    }
  });

  it("serializes concurrent daemon spawns behind the singleton startup lock", {
    timeout: 30_000,
  }, async () => {
    const layout = sashLayout(root);
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const settings = {
      ...DEFAULT_SETTINGS,
      daemonPort: port,
      secret: "test-core-secret",
      daemonSecret: "test-daemon-secret",
    };
    saveSettings(settings, layout);

    let pid: number | undefined;
    try {
      const [first, second] = await Promise.all([
        spawnDaemon({ layout, settings, timeoutMs: 15_000 }),
        spawnDaemon({ layout, settings, timeoutMs: 15_000 }),
      ]);
      pid = first.pid;
      assert.equal(second.pid, first.pid);
      const state = await evaluateDaemon(layout, settings);
      assert.equal(state.running, true);
      assert.equal(state.healthy, true);
      assert.equal(state.pid, first.pid);
    } finally {
      const stopped = await stopDaemonFromCli({ layout, settings, timeoutMs: 10_000 });
      assert.equal(stopped, true, `failed to stop spawned daemon PID ${pid ?? "unknown"}`);
    }
  });
});
