import assert from "node:assert/strict";
import fs from "node:fs";
import { it } from "node:test";
import { useDaemonTestHarness } from "./daemon-test-harness.test.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { acquireStateLockSync } from "./state-lock.js";
import { type CliRuntimeStatus, collectRuntimeStatus } from "./status.js";
import { collectEventStatus, watchRuntimeStatus } from "./status-watch.js";
import { type FakeCoreSupervisor, testStatus } from "./test-state.test.js";

const harness = useDaemonTestHarness();
const autostart = { state: "off" as const, canEnable: true, reason: null };

async function until(
  iterator: AsyncGenerator<CliRuntimeStatus>,
  matches: (status: CliRuntimeStatus) => boolean,
): Promise<CliRuntimeStatus> {
  for (let i = 0; i < 12; i++) {
    const event = await iterator.next();
    assert.equal(event.done, false, "watch ended before the expected observation");
    if (event.value && matches(event.value)) return event.value;
  }
  throw new Error("Expected status was not observed");
}

it("watches profile changes over events and reconnects after daemon replacement without starting Core", async (t) => {
  const instance = await harness.startServer();
  let lease = acquireStateLockSync(harness.layout.daemonLeaseFile, {
    purpose: "status watch fixture",
  });
  const record = () => {
    assert.ok(harness.instance);
    atomicWriteFileSync(
      harness.layout.daemonPidFile,
      JSON.stringify({
        pid: process.pid,
        token: harness.instance.token,
        port: harness.boundPort,
        startedAt: harness.instance.startedAt,
      }),
    );
  };
  record();
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    lease.release();
  });
  const reconnects: unknown[] = [];
  const iterator = watchRuntimeStatus(
    () => ({ layout: harness.layout, settings: harness.settings }),
    {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      retryMs: 10,
      onReconnect: (error) => reconnects.push(error),
      collect: (context) =>
        collectRuntimeStatus(context, {
          inspectAutostart: async () => autostart,
          inspectSystemProxy: () => harness.fakeSystemProxy().inspect(),
        }),
    },
  );
  assert.equal((await iterator.next()).value?.daemon.state, "healthy");
  const changing = until(iterator, (status) => status.activeProfile?.name === "watch-profile");
  assert.equal(
    (
      await harness.apiRequest("/sash/profiles/import", {
        method: "POST",
        body: { name: "watch-profile", content: "proxies: []\nrules: [MATCH,DIRECT]\n" },
      })
    ).statusCode,
    200,
  );
  assert.equal((await changing).activeProfile?.name, "watch-profile");
  assert.equal((instance.supervisor as FakeCoreSupervisor).starts, 0);
  const disconnected = until(iterator, (status) => status.daemon.state !== "healthy");
  await instance.close();
  lease.release();
  fs.unlinkSync(harness.layout.daemonPidFile);
  await disconnected;
  await harness.startServer();
  lease = acquireStateLockSync(harness.layout.daemonLeaseFile, {
    purpose: "replacement watch fixture",
  });
  record();
  const restarted = await until(iterator, (status) => status.daemon.state === "healthy");
  assert.equal(restarted.activeProfile?.name, "watch-profile");
  assert.ok(reconnects.length >= 1);
  controller.abort();
  assert.equal((await iterator.next()).done, true);
});

it("cancels a stopped-instance watch without initializing application state", async () => {
  const controller = new AbortController();
  const iterator = watchRuntimeStatus(
    () => ({ layout: harness.layout, settings: harness.settings }),
    {
      signal: controller.signal,
      collect: (context) =>
        collectRuntimeStatus(context, {
          inspectAutostart: async () => autostart,
          inspectSystemProxy: () => harness.fakeSystemProxy().inspect(),
        }),
    },
  );
  assert.equal((await iterator.next()).value?.daemon.state, "stopped");
  controller.abort();
  assert.equal((await iterator.next()).done, true);
  assert.equal(fs.existsSync(harness.layout.settingsFile), false);
  assert.equal(fs.existsSync(harness.layout.daemonPidFile), false);
});

it("maps event observations to the normal CLI JSON shape and preserves unknown desktop state", async () => {
  const status = testStatus();
  status.systemProxy.stateKnown = false;
  delete status.systemProxy.actual;
  const observed = await collectEventStatus(
    { layout: harness.layout, settings: harness.settings },
    {
      schemaVersion: 1,
      sequence: 1,
      status,
      autostart,
    },
  );
  assert.equal(observed.schemaVersion, 2);
  assert.equal(observed.systemProxy.osObserved.enabled, null);
  assert.equal(observed.systemProxy.osObserved.supported, null);
  assert.equal(observed.complete, false);
  assert.equal(observed.core.running, true);
});
