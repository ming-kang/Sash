import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { api } from "../api/index.js";
import type { ProfileMeta, SashStatus } from "../types/index.js";
import { refreshConnections } from "./core-actions.js";
import {
  markDaemonOffline,
  refreshRuntimeState,
  refreshStatus,
  setAllowLan,
  setSystemProxyEnabled,
  startRuntimePolling,
} from "./runtime-actions.js";
import { adoptDaemonStatus, store } from "./state.js";

const originalHasSession = api.hasSession;
beforeEach(() => {
  api.hasSession = () => true;
});
afterEach(() => {
  api.hasSession = originalHasSession;
});

function runtimeStatus(options: {
  daemonStartedAt: string;
  profileRevision: number;
  running?: boolean;
  healthy?: boolean;
  pid?: number;
  coreStartedAt?: string;
}): SashStatus {
  return {
    daemon: { pid: 100, startedAt: options.daemonStartedAt, port: 19090 },
    revisions: { profiles: options.profileRevision },
    core: {
      running: options.running ?? true,
      healthy: options.healthy ?? true,
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      ...(options.coreStartedAt === undefined ? {} : { startedAt: options.coreStartedAt }),
    },
    systemProxy: {
      desired: false,
      applied: false,
      actual: { supported: true, enabled: false },
      appliedKnown: true,
      stateKnown: true,
    },
    settings: {
      mixedPort: 17890,
      controller: "127.0.0.1:9090",
      tun: false,
      allowLan: false,
      daemonPort: 19090,
      systemProxy: false,
    },
    activeProfile: null,
  };
}

function profile(name: string): ProfileMeta {
  return {
    id: "1",
    name,
    url: "https://example.com/profile",
    intervalHours: 24,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("web runtime ownership", () => {
  it("keeps the daemon online without polling Core when browser authorization is absent", async () => {
    const originals = { getStatus: api.getStatus, getConfigs: api.getConfigs };
    const status = runtimeStatus({ daemonStartedAt: "read-only", profileRevision: 0 });
    api.hasSession = () => false;
    api.getStatus = async () => status;
    api.getConfigs = async () => {
      throw new Error("unauthorized Core poll");
    };
    try {
      assert.equal(await refreshStatus(), "unauthorized");
      assert.equal(store.daemonOnline, true);
      assert.equal(store.status, status);
      assert.equal(store.coreSnapshotError, null);
      assert.equal(store.coreSnapshotAvailable, false);
    } finally {
      Object.assign(api, originals);
      markDaemonOffline();
    }
  });
  it("forces a Core snapshot only for explicit runtime refreshes", async () => {
    const originals = {
      getStatus: api.getStatus,
      getProfiles: api.getProfiles,
      getConfigs: api.getConfigs,
      getProxies: api.getProxies,
      getRules: api.getRules,
      getConnections: api.getConnections,
    };
    const status = runtimeStatus({
      daemonStartedAt: "daemon-force",
      profileRevision: 1,
      pid: 200,
      coreStartedAt: "core-force",
    });
    let snapshotRequests = 0;

    api.getStatus = async () => status;
    api.getProfiles = async () => ({ activeId: null, profiles: [] });
    api.getConfigs = async () => {
      snapshotRequests += 1;
      return {
        port: 0,
        "socks-port": 0,
        "redir-port": 0,
        "tproxy-port": 0,
        "mixed-port": 17890,
        "allow-lan": false,
        mode: "rule",
        "log-level": "info",
      };
    };
    api.getProxies = async () => ({ proxies: {} });
    api.getRules = async () => ({ rules: [] });
    api.getConnections = async () => ({
      uploadTotal: 0,
      downloadTotal: 0,
      connections: [],
    });

    markDaemonOffline();
    try {
      assert.equal(await refreshStatus(), "full");
      assert.equal(snapshotRequests, 1);
      assert.equal(await refreshStatus(), "status");
      assert.equal(snapshotRequests, 1);

      await refreshRuntimeState();
      assert.equal(snapshotRequests, 2);
    } finally {
      Object.assign(api, originals);
      markDaemonOffline();
      store.profiles = [];
      store.activeProfileId = null;
      store.lastProfileRevision = null;
    }
  });

  it("keeps daemon, profile, and Core snapshot failures independently owned", async () => {
    const originals = {
      getStatus: api.getStatus,
      getProfiles: api.getProfiles,
      getConfigs: api.getConfigs,
      getProxies: api.getProxies,
      getRules: api.getRules,
      getConnections: api.getConnections,
    };
    let currentStatus = runtimeStatus({
      daemonStartedAt: "daemon-a",
      profileRevision: 0,
      running: false,
      healthy: false,
    });
    let profileName = "stopped-zero";
    let snapshotName = "owner-a";
    let failCore = false;
    let failConnections = false;

    api.getStatus = async () => currentStatus;
    api.getProfiles = async () => ({ activeId: "1", profiles: [profile(profileName)] });
    api.getConfigs = async () => {
      if (failCore) throw new Error("HTTP 502");
      return {
        port: 0,
        "socks-port": 0,
        "redir-port": 0,
        "tproxy-port": 0,
        "mixed-port": 17890,
        "allow-lan": false,
        mode: "rule",
        "log-level": "info",
      };
    };
    api.getProxies = async () => ({
      proxies: {
        [snapshotName]: {
          name: snapshotName,
          type: "Direct",
          udp: true,
          history: [],
        },
      },
    });
    api.getRules = async () => ({ rules: [{ type: "MATCH", payload: "", proxy: snapshotName }] });
    api.getConnections = async () => {
      if (failConnections) throw new Error("HTTP 502");
      return { uploadTotal: 12, downloadTotal: 34, connections: null };
    };

    markDaemonOffline();
    store.profiles = [];
    store.activeProfileId = null;
    try {
      assert.equal(await refreshStatus(), "stopped");
      assert.equal(store.profiles[0]?.name, "stopped-zero");
      assert.equal(store.lastProfileRevision, 0);
      assert.equal(store.daemonOnline, true);

      currentStatus = runtimeStatus({
        daemonStartedAt: "daemon-a",
        profileRevision: 1,
        running: false,
        healthy: false,
      });
      profileName = "stopped-one";
      assert.equal(await refreshStatus(), "stopped");
      assert.equal(store.profiles[0]?.name, "stopped-one");
      assert.equal(store.lastProfileRevision, 1);

      currentStatus = runtimeStatus({
        daemonStartedAt: "daemon-a",
        profileRevision: 1,
        pid: 200,
        coreStartedAt: "core-a",
      });
      assert.equal(await refreshStatus(), "full");
      assert.equal(store.coreSnapshotAvailable, true);
      assert.equal(store.coreSnapshotError, null);
      assert.ok(store.proxies["owner-a"]);
      const ownerGeneration = store.runtimeGeneration;

      failConnections = true;
      await assert.rejects(refreshConnections, /HTTP 502/);
      failConnections = false;
      assert.equal(store.daemonOnline, true);
      assert.equal(store.coreSnapshotAvailable, true);
      assert.equal(store.coreSnapshotError, "HTTP 502");
      assert.ok(store.proxies["owner-a"]);

      failCore = true;
      assert.equal(await refreshStatus(), "degraded");
      assert.equal(store.daemonOnline, true);
      assert.equal(store.coreSnapshotAvailable, true);
      assert.ok(store.proxies["owner-a"]);
      assert.equal(store.runtimeGeneration, ownerGeneration);

      currentStatus = runtimeStatus({
        daemonStartedAt: "daemon-a",
        profileRevision: 1,
        pid: 201,
        coreStartedAt: "core-b",
      });
      assert.equal(await refreshStatus(), "degraded");
      assert.equal(store.daemonOnline, true);
      assert.equal(store.coreSnapshotAvailable, false);
      assert.equal(store.coreSnapshotError, "HTTP 502");
      assert.deepEqual(store.proxies, {});
      assert.equal(store.runtimeGeneration, ownerGeneration + 1);

      failCore = false;
      snapshotName = "owner-c";
      profileName = "daemon-restarted";
      currentStatus = runtimeStatus({
        daemonStartedAt: "daemon-b",
        profileRevision: 1,
        pid: 202,
        coreStartedAt: "core-c",
      });
      assert.equal(await refreshStatus(), "full");
      assert.equal(store.profiles[0]?.name, "daemon-restarted");
      assert.equal(store.lastProfileRevision, 1);
      assert.ok(store.proxies["owner-c"]);
      const restartedGeneration = store.runtimeGeneration;

      failCore = true;
      profileName = "profile-revised";
      currentStatus = runtimeStatus({
        daemonStartedAt: "daemon-b",
        profileRevision: 2,
        pid: 202,
        coreStartedAt: "core-c",
      });
      assert.equal(await refreshStatus(), "degraded");
      assert.equal(store.profiles[0]?.name, "profile-revised");
      assert.ok(store.proxies["owner-c"]);
      assert.equal(store.runtimeGeneration, restartedGeneration);

      failCore = false;
      snapshotName = "profile-revised";
      assert.equal(await refreshStatus(), "full");
      assert.ok(store.proxies["profile-revised"]);
      assert.equal(store.runtimeGeneration, restartedGeneration + 1);
    } finally {
      Object.assign(api, originals);
      markDaemonOffline();
      store.profiles = [];
      store.activeProfileId = null;
      store.lastProfileRevision = null;
    }
  });
});

describe("network mutation outcomes", () => {
  for (const kind of ["allow-lan", "systemProxy"] as const) {
    it(`${kind}: preserves saved intent and observed proxy state when refresh fails`, async () => {
      const originals = {
        patchSettings: api.patchSettings,
        enableSystemProxy: api.enableSystemProxy,
        getStatus: api.getStatus,
      };
      const status = runtimeStatus({ daemonStartedAt: "mutation", profileRevision: 0 });
      status.core.tunActive = false;
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
          kind === "systemProxy" ? await setSystemProxyEnabled(true) : await setAllowLan(true);
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
          kind === "systemProxy" ? setSystemProxyEnabled(true) : setAllowLan(true),
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
          clearSession: api.clearSession,
        };
        const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
        const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: { setTimeout: () => 1, clearTimeout: () => undefined },
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
        api.clearSession = () => {
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
    const saving = setAllowLan(true);
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
  store.coreSnapshotAvailable = true;
  const old = Promise.withResolvers<Awaited<ReturnType<typeof api.getConnections>>>();
  api.getConnections = async () => old.promise;
  try {
    const oldRequest = refreshConnections();
    api.getConnections = async () => ({ connections: [], uploadTotal: 42, downloadTotal: 24 });
    await refreshConnections();
    old.reject(new Error("stale resource failure"));
    await assert.rejects(oldRequest, /stale resource failure/);
    assert.equal(store.connectionsUploadTotal, 42);
    assert.equal(store.coreSnapshotError, null);

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
