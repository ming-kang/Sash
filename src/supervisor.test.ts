import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sashLayout } from "./paths.js";
import { readPidRecord } from "./process.js";
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
