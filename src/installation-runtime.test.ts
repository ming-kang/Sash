import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { spawnDaemon, stopDaemonFromCli } from "./daemon-lifecycle.js";
import { installationId } from "./installation.js";
import { listInstallationInstances } from "./installation-registry.js";
import { currentPackageRoot } from "./package-info.js";
import { sashLayout } from "./paths.js";
import { createTestState, testSettings } from "./test-state.test.js";

it("registers and unregisters two real management daemons from the same installation", {
  timeout: 30_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-instance-runtime-test-"));
  const previousLocal = process.env.LOCALAPPDATA;
  const previousState = process.env.XDG_STATE_HOME;
  process.env.LOCALAPPDATA = path.join(root, "local");
  process.env.XDG_STATE_HOME = path.join(root, "xdg-state");
  const sockets = await Promise.all(
    [0, 1].map(async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server;
    }),
  );
  const ports = sockets.map((server) => {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return address.port;
  });
  await Promise.all(
    sockets.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  const instances = ports.map((port, index) => {
    const layout = sashLayout(path.join(root, `instance-${index}`));
    const settings = testSettings({ daemonPort: port });
    createTestState(layout, settings);
    return { layout, settings };
  });
  const packageRoot = currentPackageRoot();
  const id = installationId(packageRoot);
  try {
    const results = await Promise.allSettled(
      instances.map((instance) => spawnDaemon({ ...instance, timeoutMs: 15_000 })),
    );
    for (const result of results)
      assert.equal(
        result.status,
        "fulfilled",
        result.status === "rejected" ? String(result.reason) : undefined,
      );
    const records = listInstallationInstances(id, packageRoot);
    assert.equal(records.length, 2);
    assert.equal(new Set(records.map((record) => record.pid)).size, 2);
    assert.equal(new Set(records.map((record) => record.bootId)).size, 2);
    assert.deepEqual(records.map((record) => record.port).sort(), [...ports].sort());
    assert.ok(records.every((record) => !fs.existsSync(sashLayout(record.dataDir).coreExe)));
  } finally {
    try {
      const stopped = await Promise.all(instances.map((instance) => stopDaemonFromCli(instance)));
      assert.ok(stopped.every(Boolean), "all owned fixture daemons must stop before cleanup");
      assert.deepEqual(listInstallationInstances(id, packageRoot), []);
      assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } finally {
      if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousLocal;
      if (previousState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousState;
    }
  }
});
