import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import type { PublicServiceStatus } from "../../../src/contracts.js";
import { SashApiError } from "../../../src/sash-client.js";
import { api } from "../api/index.js";
import type { SashStatus } from "../types/index.js";
import { markDaemonOffline, patchBooleanSetting, refreshStatus } from "./runtime-actions.js";
import { adoptDaemonStatus, canToggleTun, store } from "./state.js";

const originals = { ...api };
let status: SashStatus;
beforeEach(() => {
  markDaemonOffline();
  status = {
    daemon: { pid: 10, startedAt: "2026-01-01T00:00:00.000Z", port: 29192 },
    core: { running: false },
    revisions: { profiles: 0 },
    settings: {
      tun: false,
      mixedPort: 27890,
      controller: "127.0.0.1:29091",
      allowLan: false,
      daemonPort: 29192,
      systemProxy: false,
    },
    systemProxy: { desired: false, applied: false, appliedKnown: true, stateKnown: true },
    activeProfile: null,
  };
  api.getStatus = async () => status;
  api.getProfiles = async () => ({ activeId: null, profiles: [] });
  api.getServiceStatus = async () => ({ supported: true, state: "ready" });
});
afterEach(() => {
  Object.assign(api, originals);
  markDaemonOffline();
  store.tunError = null;
});

for (const service of [
  { supported: true, state: "not-installed" },
  { supported: true, state: "unavailable" },
  { supported: true, state: "incompatible" },
  { supported: true, state: "root-mismatch" },
  { supported: true, state: "ready", version: "0.1.0", coreVersion: "v1.19.30" },
  { supported: false, state: "not-installed" },
] satisfies PublicServiceStatus[]) {
  it(`shares TUN eligibility for ${JSON.stringify(service)} and permits recovery off`, async () => {
    api.getServiceStatus = async () => service;
    await refreshStatus();
    assert.deepEqual(store.serviceStatus, service);
    assert.equal(canToggleTun.value, !service.supported || service.state === "ready");
    adoptDaemonStatus({ ...status, settings: { ...status.settings, tun: true } });
    assert.equal(canToggleTun.value, true);
    store.operations = { ...store.operations, networkSetting: true };
    assert.equal(canToggleTun.value, false);
    store.operations = { ...store.operations, networkSetting: false };
  });
}
it("caches status for five seconds, invalidating on a new daemon boot", async () => {
  let calls = 0;
  api.getServiceStatus = async () => {
    calls++;
    return { supported: true, state: "ready" };
  };
  await refreshStatus();
  await refreshStatus();
  assert.equal(calls, 1);
  store.serviceCheckedAt = Date.now() - 5001;
  await refreshStatus();
  assert.equal(calls, 2);
  status = { ...status, daemon: { ...status.daemon, startedAt: "2026-02-01T00:00:00.000Z" } };
  await refreshStatus();
  assert.equal(calls, 3);
});
it("discards delayed service observations from a superseded runtime generation", async () => {
  const pending = Promise.withResolvers<PublicServiceStatus>();
  const entered = Promise.withResolvers<void>();
  api.getServiceStatus = async () => {
    entered.resolve();
    return pending.promise;
  };
  const old = refreshStatus();
  await entered.promise;
  status = { ...status, daemon: { ...status.daemon, startedAt: "2026-02-01T00:00:00.000Z" } };
  api.getServiceStatus = async () => ({ supported: true, state: "unavailable" });
  await refreshStatus();
  pending.resolve({ supported: true, state: "ready" });
  await old;
  assert.equal(store.serviceStatus?.state, "unavailable");
});
it("discards service responses after session generation changes", async () => {
  const pending = Promise.withResolvers<PublicServiceStatus>();
  const entered = Promise.withResolvers<void>();
  let session = 1;
  api.getSessionGeneration = () => session;
  api.getServiceStatus = async () => {
    entered.resolve();
    return pending.promise;
  };
  const refreshing = refreshStatus();
  await entered.promise;
  session++;
  pending.resolve({ supported: true, state: "ready" });
  await refreshing;
  assert.equal(store.serviceStatus, null);
});
it("keeps typed service_required guidance inline when discovery is unknown", async () => {
  api.getServiceStatus = async () => {
    throw new Error("query unavailable");
  };
  await refreshStatus();
  assert.equal(canToggleTun.value, true);
  const failure = new SashApiError(
    409,
    "service_required",
    "Install with sash service install in Administrator PowerShell, then start Sash normally.",
  );
  api.patchSettings = async () => {
    throw failure;
  };
  await assert.rejects(patchBooleanSetting("tun", true), (error) => error === failure);
  await refreshStatus();
  assert.equal(store.tunError, failure.message);
  assert.equal(store.status?.settings.tun, false);
});
