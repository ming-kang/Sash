import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { sashLayout } from "./paths.js";
import { CoreSupervisor } from "./supervisor.js";
import { testSettings } from "./testing/state.js";

it("shares status probes, caches only diagnostics, and invalidates observations on Core replacement", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-status-cache-test-"));
  const layout = sashLayout(root);
  fs.mkdirSync(layout.binDir);
  fs.mkdirSync(path.dirname(layout.configFile));
  fs.writeFileSync(layout.coreExe, "owned fixture");
  fs.writeFileSync(layout.configFile, "tun: {enable: false}\n");
  let now = 0;
  t.mock.method(performance, "now", () => now);
  let probes = 0;
  const server = http.createServer((_req, res) => {
    probes += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: "v1" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let alive = false;
  let pid = 5150;
  let child: ChildProcess | undefined;
  const supervisor = new CoreSupervisor({
    layout,
    settings: () => testSettings({ controller: `127.0.0.1:${address.port}` }),
    spawnFn: () => {
      alive = true;
      child = Object.assign(new EventEmitter(), { pid: ++pid }) as ChildProcess;
      return child;
    },
    isAliveFn: () => alive,
    killFn: async () => {
      alive = false;
      return true;
    },
  });
  try {
    await supervisor.start();
    const before = probes;
    const observed = await Promise.all([0, 1, 2].map(() => supervisor.status({ fresh: false })));
    assert.equal(probes, before + 1);
    assert.ok(observed.every((state) => state.healthy));
    const first = observed[0];
    assert.ok(first);
    first.healthy = false;
    assert.equal((await supervisor.status({ fresh: false })).healthy, true);
    assert.equal(probes, before + 1);
    await supervisor.status();
    assert.equal(probes, before + 2, "safety callers must bypass a settled observation");
    now = 501;
    await supervisor.status({ fresh: false });
    assert.equal(probes, before + 3, "expired observations must be probed again");
    alive = false;
    assert.ok(child);
    child.emit("exit", 0, null);
    assert.deepEqual(await supervisor.status({ fresh: false }), { running: false });
    await supervisor.start();
    const restarted = probes;
    assert.equal((await supervisor.status({ fresh: false })).pid, pid);
    assert.equal(probes, restarted + 1, "a new Core must never inherit a cached observation");
  } finally {
    await supervisor.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
