import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { testStatus } from "../../../src/testing/state.js";
import { api } from "../api/index.js";
import {
  markDaemonOffline,
  saveNetworkSettings,
  setSystemProxyEnabled,
} from "./runtime-actions.js";
import { adoptDaemonStatus, store } from "./state.js";

const originalApi = { ...api };

beforeEach(() => {
  api.hasSession = () => true;
  api.sessionMatches = () => true;
  api.markDisconnected = () => undefined;
  api.getProfiles = async () => ({ activeId: null, profiles: [] });
  markDaemonOffline();
});

afterEach(() => {
  markDaemonOffline();
  Object.assign(api, originalApi);
});

describe("network mutation outcomes", () => {
  it("keeps the original write error and still re-syncs status after a rejection", async () => {
    adoptDaemonStatus(testStatus());
    const failure = new Error("setting rejected: backend details");
    let refreshes = 0;
    api.patchSettings = async () => {
      throw failure;
    };
    api.getStatus = async () => {
      refreshes += 1;
      throw new Error("refresh failed");
    };

    await assert.rejects(saveNetworkSettings({ allowLan: true }), (error) => error === failure);
    assert.equal(refreshes, 1, "a rejected write still re-syncs status");
    assert.equal(store.operations.networkSetting, false);
  });

  it("reports an unverified save when the write succeeds but status cannot be read", async () => {
    const status = testStatus();
    adoptDaemonStatus(status);
    api.enableSystemProxy = async () => ({
      revision: 1,
      settings: { ...status.settings, systemProxy: true },
      restartRequired: false,
    });
    api.getStatus = async () => {
      throw new Error("refresh failed");
    };

    assert.equal(await setSystemProxyEnabled(true), false, "the view shows saved but unverified");
    assert.equal(store.operations.systemProxy, false);
  });

  it("rejects an impossible system proxy change without calling the daemon", async () => {
    adoptDaemonStatus({ ...testStatus(), core: { running: false } });
    let calls = 0;
    api.enableSystemProxy = async () => {
      calls += 1;
      throw new Error("must not be called");
    };

    await assert.rejects(setSystemProxyEnabled(true));
    assert.equal(calls, 0);
    assert.equal(store.operations.systemProxy, false);
  });
});
