import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { api } from "../api/index.js";
import type { ProfileMeta, SashStatus } from "../types/index.js";
import { refreshConnections } from "./core-actions.js";
import { markDaemonOffline, refreshRuntimeState, refreshStatus } from "./runtime-actions.js";
import { store } from "./state.js";

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
