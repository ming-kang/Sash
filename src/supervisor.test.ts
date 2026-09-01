import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sashLayout } from "./paths.js";
import { readPidRecord, writePidRecord } from "./process.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { CoreSupervisor } from "./supervisor.js";

/**
 * Regression test for the restart race: when `restart()` stops the old core
 * and starts a new one, the old process's `exit` event may be dispatched
 * AFTER the new child handle is assigned. A stale exit must not clear the
 * new child, the new PID record, or fire the onExit callback.
 */
test("restart: stale exit event from the replaced core does not clobber the new one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-supervisor-"));
  const layout = sashLayout(root);
  fs.mkdirSync(path.dirname(layout.coreExe), { recursive: true });
  fs.writeFileSync(layout.coreExe, "fake-core");
  fs.writeFileSync(layout.configFile, "mixed-port: 1\n");

  // Stub external-controller: healthy /version for the startup health check.
  const server = http.createServer((req, res) => {
    if (req.url === "/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "v-test", meta: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const children: ChildProcess[] = [];
  const spawnFn = (): ChildProcess => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    return child;
  };

  const settings = { ...DEFAULT_SETTINGS, controller: `127.0.0.1:${port}`, secret: "" };
  let exitCalls = 0;
  const supervisor = new CoreSupervisor({
    layout,
    settings: () => settings,
    spawnFn,
    waitHealthyMs: 8000,
    onExit: () => {
      exitCalls += 1;
    },
  });

  try {
    const first = await supervisor.start();
    const oldChild = children[0];
    assert.ok(oldChild);
    assert.equal((await supervisor.status()).pid, first.pid);

    const second = await supervisor.restart();
    assert.ok(second.pid);
    assert.notEqual(first.pid, second.pid);

    // Simulate the late-arriving exit event from the replaced process. On
    // Windows the event is routinely dispatched only after start() has
    // already assigned the new child handle.
    if (oldChild.listenerCount("exit") > 0) {
      oldChild.emit("exit", 0, null);
    }

    const state = await supervisor.status();
    assert.equal(state.running, true);
    assert.equal(state.pid, second.pid);
    assert.equal(state.healthy, true);
    assert.equal(exitCalls, 0);

    const record = readPidRecord(layout.pidFile);
    assert.equal(record?.pid, second.pid);
  } finally {
    await supervisor.stop().catch(() => {});
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stop preserves Core ownership when termination cannot be confirmed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-supervisor-stop-test-"));
  const layout = sashLayout(root);
  fs.mkdirSync(path.dirname(layout.coreExe), { recursive: true });
  fs.writeFileSync(layout.coreExe, "fake-core");
  fs.writeFileSync(layout.configFile, "mixed-port: 1\n");

  const server = http.createServer((req, res) => {
    if (req.url === "/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "v-test", meta: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const fakeChild = Object.assign(new EventEmitter(), { pid: 4242 }) as ChildProcess;
  const settings = { ...DEFAULT_SETTINGS, controller: `127.0.0.1:${port}` };
  const supervisor = new CoreSupervisor({
    layout,
    settings: () => settings,
    spawnFn: () => fakeChild,
    isAliveFn: (pid) => pid === fakeChild.pid,
    killFn: async () => false,
  });

  try {
    await supervisor.start();
    await assert.rejects(supervisor.stop(), /still running after termination attempt/);
    assert.equal(supervisor.isRunning(), true);
    assert.equal(readPidRecord(layout.pidFile)?.pid, fakeChild.pid);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale Core cleanup preserves PID state when identity is unknown", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-supervisor-stale-test-"));
  const layout = sashLayout(root);
  writePidRecord(layout.pidFile, {
    pid: 4242,
    exe: layout.coreExe,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  let killCalled = false;
  const supervisor = new CoreSupervisor({
    layout,
    settings: () => ({ ...DEFAULT_SETTINGS }),
    isAliveFn: () => true,
    classifyIdentityFn: () => "unknown",
    killFn: async () => {
      killCalled = true;
      return true;
    },
  });

  try {
    await assert.rejects(supervisor.cleanStaleCore(), /identity could not be verified/);
    assert.equal(killCalled, false);
    assert.equal(readPidRecord(layout.pidFile)?.pid, 4242);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale Core cleanup clears a PID record that belongs to another executable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-supervisor-mismatch-test-"));
  const layout = sashLayout(root);
  writePidRecord(layout.pidFile, {
    pid: 4242,
    exe: layout.coreExe,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  const supervisor = new CoreSupervisor({
    layout,
    settings: () => ({ ...DEFAULT_SETTINGS }),
    isAliveFn: () => true,
    classifyIdentityFn: () => "mismatch",
  });

  try {
    await supervisor.cleanStaleCore();
    assert.equal(readPidRecord(layout.pidFile), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("start terminates the child when PID ownership cannot be persisted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-supervisor-pid-write-test-"));
  const layout = sashLayout(root);
  fs.mkdirSync(path.dirname(layout.coreExe), { recursive: true });
  fs.writeFileSync(layout.coreExe, "fake-core");
  fs.writeFileSync(layout.configFile, "mixed-port: 1\n");
  fs.mkdirSync(layout.pidFile, { recursive: true });
  const fakeChild = Object.assign(new EventEmitter(), { pid: 4343 }) as ChildProcess;
  let alive = true;
  let killCalls = 0;
  const supervisor = new CoreSupervisor({
    layout,
    settings: () => ({ ...DEFAULT_SETTINGS }),
    spawnFn: () => fakeChild,
    isAliveFn: () => alive,
    killFn: async () => {
      killCalls++;
      alive = false;
      return true;
    },
  });

  try {
    await assert.rejects(supervisor.start(), /Failed to persist Core PID ownership/);
    assert.equal(killCalls, 1);
    assert.equal(supervisor.isRunning(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale Core cleanup rejects a corrupt PID record", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-supervisor-corrupt-pid-test-"));
  const layout = sashLayout(root);
  fs.mkdirSync(layout.stateDir, { recursive: true });
  fs.writeFileSync(layout.pidFile, "{ broken");
  const supervisor = new CoreSupervisor({
    layout,
    settings: () => ({ ...DEFAULT_SETTINGS }),
  });

  try {
    await assert.rejects(supervisor.cleanStaleCore(), /Core PID record is corrupt/);
    assert.equal(fs.readFileSync(layout.pidFile, "utf8"), "{ broken");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("status reports stopped when its controller probe outlives the owned child", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-supervisor-status-race-test-"));
  const layout = sashLayout(root);
  fs.mkdirSync(path.dirname(layout.coreExe), { recursive: true });
  fs.writeFileSync(layout.coreExe, "fake-core");
  fs.writeFileSync(layout.configFile, "mixed-port: 1\n");

  let holdResponse: (() => void) | undefined;
  let probeStarted: (() => void) | undefined;
  const probeSeen = new Promise<void>((resolve) => {
    probeStarted = resolve;
  });
  let delayProbe = false;
  const server = http.createServer((_req, res) => {
    const respond = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "v-test", meta: true }));
    };
    if (delayProbe) {
      probeStarted?.();
      holdResponse = respond;
      return;
    }
    respond();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const child = Object.assign(new EventEmitter(), { pid: 5151 }) as ChildProcess;
  let alive = true;
  const supervisor = new CoreSupervisor({
    layout,
    settings: () => ({ ...DEFAULT_SETTINGS, controller: `127.0.0.1:${port}` }),
    spawnFn: () => child,
    isAliveFn: () => alive,
    waitHealthyMs: 2000,
  });

  try {
    await supervisor.start();
    delayProbe = true;
    const status = supervisor.status();
    await probeSeen;
    alive = false;
    child.emit("exit", 0, null);
    holdResponse?.();

    assert.deepEqual(await status, { running: false });
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale Core cleanup never trusts an executable path supplied by the PID record", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-supervisor-recorded-exe-test-"));
  const layout = sashLayout(root);
  writePidRecord(layout.pidFile, {
    pid: process.pid,
    exe: process.execPath,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  let killCalled = false;
  const supervisor = new CoreSupervisor({
    layout,
    settings: () => ({ ...DEFAULT_SETTINGS }),
    isAliveFn: () => true,
    classifyIdentityFn: () => "match",
    killFn: async () => {
      killCalled = true;
      return true;
    },
  });

  try {
    await assert.rejects(supervisor.cleanStaleCore(), /does not match the managed path/);
    assert.equal(killCalled, false);
    assert.equal(readPidRecord(layout.pidFile)?.pid, process.pid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
