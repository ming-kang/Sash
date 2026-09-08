import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { testProfile, testStatus } from "../../../src/test-state.test.js";
import { api } from "../api/index.js";
import { currentRoute } from "../router.js";
import type { SashStatus } from "../types/index.js";
import { refreshConnections, refreshVisibleCoreResources } from "./core-actions.js";
import {
  markDaemonOffline,
  refreshRuntimeState,
  refreshStatus,
  saveNetworkSettings,
  setSystemProxyEnabled,
  startRuntimePolling,
} from "./runtime-actions.js";
import { adoptDaemonStatus, store } from "./state.js";

const originalApi = { ...api };
beforeEach(() => {
  api.hasSession = () => true;
  api.sessionMatches = () => true;
  api.isInitialized = () => false;
  api.markDisconnected = () => undefined;
  api.getProfiles = async () => ({ activeId: null, profiles: [] });
  markDaemonOffline();
  currentRoute.value = "overview";
  store.profiles = [];
  store.lastProfileRevision = null;
});
afterEach(() => {
  markDaemonOffline();
  Object.assign(api, originalApi);
});

function runtimeStatus(options: {
  daemonStartedAt: string;
  profileRevision: number;
  running?: boolean;
  healthy?: boolean;
  runtimeRevision?: number;
}): SashStatus {
  const value = testStatus();
  value.daemon.bootId = options.daemonStartedAt;
  value.revisions.profiles = options.profileRevision;
  value.revisions.runtime = options.runtimeRevision ?? 1;
  value.core.running = options.running ?? true;
  value.core.healthy = options.healthy ?? true;
  return value;
}

describe("web runtime ownership", () => {
  function coreResponses(): string[] {
    const reads: string[] = [];
    api.getConfigs = async () => {
      reads.push("configs");
      return { mode: "rule" } as Awaited<ReturnType<typeof api.getConfigs>>;
    };
    api.getProxies = async () => {
      reads.push("proxies");
      return { proxies: { node: { name: "node", type: "Direct", udp: true, history: [] } } };
    };
    api.getRules = async () => {
      reads.push("rules");
      return { rules: [{ type: "MATCH", payload: "", proxy: "DIRECT" }] };
    };
    api.getConnections = async () => {
      reads.push("connections");
      return { connections: null, uploadTotal: 12, downloadTotal: 34 };
    };
    return reads;
  }

  it("keeps public daemon status online without polling private resources when unauthorized", async () => {
    const status = testStatus();
    api.sessionMatches = () => false;
    api.hasSession = () => false;
    api.getStatus = async () => status;
    api.getProfiles = async () => {
      throw new Error("unauthorized profile poll");
    };
    const reads = coreResponses();
    assert.equal(await refreshStatus(), "unauthorized");
    assert.equal(store.daemonOnline, true);
    assert.equal(store.status, status);
    assert.deepEqual(store.resourceLoaded, {});
    assert.deepEqual(reads, []);
  });

  it("loads resources only for the visible page and keeps status refreshes lightweight", async () => {
    api.getStatus = async () => testStatus();
    const reads = coreResponses();
    assert.equal(await refreshStatus(), "status");
    assert.deepEqual(reads, []);
    await refreshRuntimeState();
    assert.deepEqual(reads.sort(), ["configs", "connections", "proxies"]);
    currentRoute.value = "profiles";
    await refreshRuntimeState();
    assert.equal(reads.length, 3);
    currentRoute.value = "rules";
    await refreshVisibleCoreResources();
    assert.equal(reads.at(-1), "rules");
    await refreshVisibleCoreResources(1);
    assert.equal(reads.length, 4, "unchanged rules should stay cached");
  });

  it("preserves Core caches and measured delays across metadata changes", async () => {
    let status = testStatus();
    let profile = testProfile();
    api.getStatus = async () => status;
    api.getProfiles = async () => ({ activeId: profile.id, profiles: [profile] });
    const reads = coreResponses();
    await refreshRuntimeState();
    const generation = store.runtimeGeneration;
    const proxies = store.proxies;
    store.manualProxyDelays = { node: 42 };
    status = { ...status, revisions: { ...status.revisions, profiles: 2 } };
    profile = { ...profile, name: "renamed" };
    await refreshStatus();
    assert.equal(store.profiles[0]?.name, "renamed");
    assert.equal(store.proxies, proxies);
    assert.equal(store.manualProxyDelays.node, 42);
    assert.equal(store.runtimeGeneration, generation);
    assert.equal(reads.length, 3);

    status = { ...status, revisions: { ...status.revisions, runtime: 2 } };
    await refreshStatus();
    assert.equal(store.runtimeGeneration, generation + 1);
    assert.deepEqual(store.proxies, {});
    assert.deepEqual(store.manualProxyDelays, {});
    assert.deepEqual(store.resourceLoaded, {});
  });

  it("retains a failed resource while updating independent successful resources", async () => {
    api.getStatus = async () => testStatus();
    coreResponses();
    await refreshRuntimeState();
    const proxies = store.proxies;
    api.getProxies = async () => {
      throw new Error("proxy query failed");
    };
    api.getConnections = async () => ({ connections: [], uploadTotal: 100, downloadTotal: 200 });
    await refreshRuntimeState();
    assert.equal(store.proxies, proxies);
    assert.equal(store.resourceLoaded.proxies, true);
    assert.deepEqual(store.resourceErrors, { proxies: "proxy query failed" });
    assert.equal(store.connectionsUploadTotal, 100);
    assert.equal(store.daemonOnline, true);
  });

  it("retries failed metadata loads and invalidates profile revisions on a new daemon boot", async () => {
    let status = testStatus();
    api.getStatus = async () => status;
    api.getProfiles = async () => {
      throw new Error("metadata query failed");
    };
    assert.equal(await refreshStatus(), "status");
    assert.equal(store.lastProfileRevision, null);
    api.getProfiles = async () => ({ activeId: "1", profiles: [testProfile()] });
    await refreshStatus();
    assert.equal(store.lastProfileRevision, 0);
    status = { ...status, daemon: { ...status.daemon, bootId: "new-boot" } };
    api.getProfiles = async () => ({ activeId: "2", profiles: [testProfile("2")] });
    await refreshStatus();
    assert.equal(store.activeProfileId, "2");
  });
});

describe("network mutation outcomes", () => {
  for (const kind of ["allow-lan", "systemProxy"] as const) {
    it(`${kind}: a late write response cannot change the successor daemon's settings`, async () => {
      const status = testStatus();
      adoptDaemonStatus(status);
      const pending = Promise.withResolvers<Awaited<ReturnType<typeof api.patchSettings>>>();
      api.patchSettings = api.enableSystemProxy = async () => pending.promise;
      api.getStatus = async () => {
        throw new Error("temporarily unavailable");
      };
      const saving =
        kind === "systemProxy"
          ? setSystemProxyEnabled(true)
          : saveNetworkSettings({ allowLan: true });
      const successor = { ...testStatus(), daemon: { ...status.daemon, bootId: "successor" } };
      adoptDaemonStatus(successor);
      pending.resolve({
        settings: { ...status.settings, allowLan: true, systemProxy: true },
        restartRequired: true,
      });
      await saving;
      assert.equal(store.status, successor);
      assert.equal(store.status.settings.allowLan, false);
      assert.equal(store.status.settings.systemProxy, false);
    });

    it(`${kind}: preserves saved intent and observed proxy state when refresh fails`, async () => {
      const originals = {
        patchSettings: api.patchSettings,
        enableSystemProxy: api.enableSystemProxy,
        getStatus: api.getStatus,
      };
      const status = runtimeStatus({ daemonStartedAt: "mutation", profileRevision: 0 });
      adoptDaemonStatus(status);
      const settings = {
        ...status.settings,
        allowLan: kind === "allow-lan",
        systemProxy: kind === "systemProxy",
      };
      api.patchSettings = api.enableSystemProxy = async () => ({
        settings,
        restartRequired: false,
      });
      api.getStatus = async () => {
        throw new Error("refresh failed");
      };
      try {
        const verified =
          kind === "systemProxy"
            ? await setSystemProxyEnabled(true)
            : await saveNetworkSettings({ allowLan: true });
        assert.equal(verified, false);
        assert.deepEqual(store.status?.settings, settings);
        assert.deepEqual(store.status?.systemProxy, {
          ...status.systemProxy,
          desired: settings.systemProxy,
        });
        assert.equal(store.operations.networkSetting, false);
        assert.equal(store.operations.systemProxy, false);
      } finally {
        Object.assign(api, originals);
        markDaemonOffline();
      }
    });

    it(`${kind}: refreshes possible partial writes but preserves the original mutation error`, async () => {
      const originals = {
        patchSettings: api.patchSettings,
        enableSystemProxy: api.enableSystemProxy,
        getStatus: api.getStatus,
      };
      adoptDaemonStatus(runtimeStatus({ daemonStartedAt: "mutation-error", profileRevision: 0 }));
      const failure = new Error("setting rejected: backend details");
      let refreshes = 0;
      api.patchSettings = api.enableSystemProxy = async () => {
        throw failure;
      };
      api.getStatus = async () => {
        refreshes += 1;
        throw new Error("refresh failed");
      };
      try {
        await assert.rejects(
          kind === "systemProxy"
            ? setSystemProxyEnabled(true)
            : saveNetworkSettings({ allowLan: true }),
          (error) => error === failure,
        );
        assert.equal(refreshes, 1);
        assert.equal(store.status?.settings.allowLan, false);
      } finally {
        Object.assign(api, originals);
        markDaemonOffline();
      }
    });
  }
});

describe("stale polling failures", () => {
  for (const phase of ["initialize", "status"] as const) {
    for (const stopped of [false, true]) {
      it(`ignores ${phase} failure after newer status (poll stopped: ${stopped})`, async () => {
        const originals = {
          initialize: api.initialize,
          getStatus: api.getStatus,
          getProfiles: api.getProfiles,
          markDisconnected: api.markDisconnected,
        };
        const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
        const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: {
            setTimeout: () => 1,
            clearTimeout: () => undefined,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          },
        });
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: {
            hidden: false,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          },
        });
        const pending = Promise.withResolvers<never>();
        const entered = Promise.withResolvers<void>();
        let clears = 0;
        api.markDisconnected = () => {
          clears += 1;
        };
        api.initialize = async () => {
          if (phase === "initialize") {
            entered.resolve();
            return pending.promise;
          }
          return { token: "test", pid: 100, startedAt: "2026-01-01T00:00:00.000Z" };
        };
        api.getStatus = async () => {
          entered.resolve();
          return pending.promise;
        };
        api.getProfiles = async () => ({ activeId: null, profiles: [] });
        const stop = startRuntimePolling();
        try {
          await entered.promise;
          if (stopped) stop();
          const latest = runtimeStatus({
            daemonStartedAt: "newer",
            profileRevision: 0,
            running: false,
            healthy: false,
          });
          api.getStatus = async () => latest;
          await refreshStatus();
          pending.reject(new Error("old failure"));
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(store.daemonOnline, true);
          assert.equal(store.status, latest);
          assert.equal(clears, 0);
        } finally {
          stop();
          Object.assign(api, originals);
          if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
          else Reflect.deleteProperty(globalThis, "window");
          if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
          else Reflect.deleteProperty(globalThis, "document");
          markDaemonOffline();
        }
      });
    }
  }
});

it("keeps LAN intent committed while saving and preserves an unrelated system proxy", async () => {
  const originals = {
    patchSettings: api.patchSettings,
    disableSystemProxy: api.disableSystemProxy,
    getStatus: api.getStatus,
  };
  const status = runtimeStatus({ daemonStartedAt: "pending-toggle", profileRevision: 0 });
  status.settings.systemProxy = true;
  status.systemProxy.desired = true;
  status.systemProxy.applied = true;
  status.systemProxy.actual = { supported: true, enabled: true };
  adoptDaemonStatus(status);
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof api.patchSettings>>>();
  api.patchSettings = async () => pending.promise;
  api.disableSystemProxy = async () => {
    throw new Error("must not disable system proxy");
  };
  api.getStatus = async () => {
    throw new Error("refresh unavailable");
  };
  try {
    const saving = saveNetworkSettings({ allowLan: true });
    assert.equal(store.status?.settings.allowLan, false);
    assert.equal(store.operations.networkSetting, true);
    pending.resolve({ settings: { ...status.settings, allowLan: true }, restartRequired: false });
    assert.equal(await saving, false);
    assert.equal(store.status?.settings.allowLan, true);
    assert.deepEqual(store.status?.systemProxy, status.systemProxy);
  } finally {
    Object.assign(api, originals);
    markDaemonOffline();
  }
});

it("resource requests do not supersede status and older resource failures cannot degrade newer data", async () => {
  const originals = { getStatus: api.getStatus, getConnections: api.getConnections };
  const status = runtimeStatus({ daemonStartedAt: "resource-order", profileRevision: 0 });
  adoptDaemonStatus(status);
  store.lastProfileRevision = 0;
  store.resourceLoaded = { connections: true };
  const old = Promise.withResolvers<Awaited<ReturnType<typeof api.getConnections>>>();
  api.getConnections = async () => old.promise;
  try {
    const oldRequest = refreshConnections();
    api.getConnections = async () => ({ connections: [], uploadTotal: 42, downloadTotal: 24 });
    await refreshConnections();
    old.reject(new Error("stale resource failure"));
    await assert.rejects(oldRequest, /stale resource failure/);
    assert.equal(store.connectionsUploadTotal, 42);
    assert.deepEqual(store.resourceErrors, {});

    const pending = Promise.withResolvers<SashStatus>();
    api.getStatus = async () => pending.promise;
    const refreshing = refreshStatus();
    await refreshConnections();
    const stopped = runtimeStatus({
      daemonStartedAt: "resource-order",
      profileRevision: 0,
      running: false,
      healthy: false,
    });
    pending.resolve(stopped);
    assert.equal(await refreshing, "stopped");
    assert.equal(store.status, stopped);
  } finally {
    Object.assign(api, originals);
    markDaemonOffline();
  }
});
