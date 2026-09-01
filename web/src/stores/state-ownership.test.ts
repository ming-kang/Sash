import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SashStatus } from "../types/index.js";
import {
  canSetSystemProxyTarget,
  clearCoreOwnedState,
  needsRecoveryRefresh,
  RequestGenerations,
  resolvedProxyDelay,
  runProfileMutationSequence,
  syncCommittedBooleanSetting,
} from "./state-ownership.js";

function status(
  overrides: {
    daemonStartedAt?: string;
    running?: boolean;
    healthy?: boolean;
    pid?: number;
    profileRevision?: number;
    desiredProxy?: boolean;
    appliedProxy?: boolean;
    actualProxy?: boolean;
  } = {},
): SashStatus {
  return {
    daemon: {
      pid: 100,
      startedAt: overrides.daemonStartedAt ?? "2026-01-01T00:00:00.000Z",
      port: 19090,
    },
    revisions: { profiles: overrides.profileRevision ?? 0 },
    core: {
      running: overrides.running ?? true,
      healthy: overrides.healthy ?? true,
      pid: overrides.pid ?? 200,
      startedAt: "2026-01-01T00:00:01.000Z",
    },
    systemProxy: {
      desired: overrides.desiredProxy ?? false,
      applied: overrides.appliedProxy ?? false,
      actual: { supported: true, enabled: overrides.actualProxy ?? false },
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

describe("frontend state ownership helpers", () => {
  it("discards a slower response after a newer request starts", async () => {
    const generations = new RequestGenerations();
    const committed: string[] = [];
    let releaseOld: (() => void) | undefined;
    const oldResponse = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });

    const oldGeneration = generations.begin("runtime");
    const oldCommit = oldResponse.then(() => {
      if (generations.isCurrent("runtime", oldGeneration)) committed.push("old");
    });
    const newGeneration = generations.begin("runtime");
    if (generations.isCurrent("runtime", newGeneration)) committed.push("new");
    releaseOld?.();
    await oldCommit;

    assert.deepEqual(committed, ["new"]);
  });

  it("clears every Core-owned snapshot when runtime becomes unavailable", () => {
    const owned = {
      mode: "global" as const,
      proxies: { node: { name: "node", type: "Direct", udp: true, history: [] } },
      proxyGroups: ["GLOBAL"],
      connections: [{ id: "connection" }],
      connectionsUploadTotal: 12,
      connectionsDownloadTotal: 34,
      rules: [{ type: "MATCH" }],
      traffic: { up: 5, down: 6, historyUp: [1, 2], historyDown: [3, 4] },
      manualProxyDelays: { node: 88 },
      activeGroup: "GLOBAL",
      runtimeGeneration: 7,
    };

    clearCoreOwnedState(owned, 3);

    assert.equal(owned.mode, "rule");
    assert.deepEqual(owned.proxies, {});
    assert.deepEqual(owned.proxyGroups, []);
    assert.deepEqual(owned.connections, []);
    assert.equal(owned.connectionsUploadTotal, 0);
    assert.equal(owned.connectionsDownloadTotal, 0);
    assert.deepEqual(owned.rules, []);
    assert.deepEqual(owned.traffic, {
      up: 0,
      down: 0,
      historyUp: [0, 0, 0],
      historyDown: [0, 0, 0],
    });
    assert.deepEqual(owned.manualProxyDelays, {});
    assert.equal(owned.activeGroup, "");
    assert.equal(owned.runtimeGeneration, 8);
  });

  it("requests one recovery refresh for health, daemon boot, Core, or profile revision changes", () => {
    const current = status();
    assert.equal(needsRecoveryRefresh(null, current), true);
    assert.equal(needsRecoveryRefresh(status({ running: false, healthy: false }), current), true);
    assert.equal(needsRecoveryRefresh(current, status()), false);
    assert.equal(needsRecoveryRefresh(current, status({ daemonStartedAt: "later" })), true);
    assert.equal(needsRecoveryRefresh(current, status({ pid: 201 })), true);
    assert.equal(needsRecoveryRefresh(current, status({ profileRevision: 1 })), true);
  });

  it("keeps a manual delay across normal proxy snapshot replacement", () => {
    const manual = { node: 42 };
    const initial = {
      node: {
        name: "node",
        type: "Direct",
        udp: true,
        history: [{ time: "old", delay: 800 }],
      },
    };
    const polled = {
      node: {
        name: "node",
        type: "Direct",
        udp: true,
        history: [{ time: "new", delay: 900 }],
      },
    };

    assert.equal(resolvedProxyDelay("node", initial, manual), 42);
    assert.equal(resolvedProxyDelay("node", polled, manual), 42);
    assert.equal(resolvedProxyDelay("node", polled, {}), 900);
  });

  it("synchronizes a successfully committed settings toggle immediately", () => {
    const previous = status();
    const next = syncCommittedBooleanSetting(previous, "allow-lan", true);

    assert.equal(previous.settings.allowLan, false);
    assert.equal(next?.settings.allowLan, true);
    assert.equal(next?.settings.tun, false);
  });

  it("refreshes profiles after a single-profile update failure before rethrowing", async () => {
    const order: string[] = [];
    const failure = new Error("download failed");

    await assert.rejects(
      runProfileMutationSequence(
        async () => {
          order.push("mutation");
          throw failure;
        },
        async () => {
          order.push("refresh-profiles");
        },
        async () => {
          order.push("refresh-runtime");
        },
      ),
      failure,
    );

    assert.deepEqual(order, ["mutation", "refresh-profiles"]);
  });

  it("allows proxy disable recovery while stopped but requires health for enable", () => {
    const stopped = status({
      running: false,
      healthy: false,
      desiredProxy: true,
      appliedProxy: false,
    });
    assert.equal(canSetSystemProxyTarget(stopped, false), true);
    assert.equal(canSetSystemProxyTarget(stopped, true), false);
    assert.equal(canSetSystemProxyTarget(status(), true), true);
  });
});
