import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { deferredValue, testProfile, testStatus } from "../../../src/testing/state.js";
import { api } from "../api/index.js";
import type { ProfilesResponse, SashStatus } from "../types/index.js";
import { profilesSyncNeeded, syncProfiles } from "./profile-sync.js";
import { adoptDaemonStatus, store } from "./state.js";

const originalApi = { ...api };

function statusAt(revision: number, bootId = "test-boot"): SashStatus {
  const status = testStatus();
  status.daemon.bootId = bootId;
  status.revisions.state = revision;
  return status;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  api.getProfiles = async () => ({ activeId: null, profiles: [] });
  adoptDaemonStatus(statusAt(0));
  store.profiles = [];
  store.activeProfileId = null;
  store.profilesLoaded = false;
  store.lastStateRevision = null;
});

afterEach(() => {
  Object.assign(api, originalApi);
  store.status = null;
  store.profiles = [];
  store.activeProfileId = null;
  store.profilesLoaded = false;
  store.lastStateRevision = null;
});

describe("profile sync owner", () => {
  it("flags sync need only for a stale or unloaded snapshot", () => {
    store.status = null;
    assert.equal(profilesSyncNeeded(), false);

    adoptDaemonStatus(statusAt(1));
    assert.equal(profilesSyncNeeded(), true, "profiles not loaded yet");

    store.profilesLoaded = true;
    assert.equal(profilesSyncNeeded(), true, "revision still unknown");
    store.lastStateRevision = 1;
    assert.equal(profilesSyncNeeded(), false);

    adoptDaemonStatus(statusAt(2));
    assert.equal(profilesSyncNeeded(), true, "revision advanced");
  });

  it("coalesces concurrent sync calls into one profile fetch", async () => {
    adoptDaemonStatus(statusAt(3));
    const pending = deferredValue<ProfilesResponse>();
    let fetches = 0;
    api.getProfiles = () => {
      fetches += 1;
      return pending.promise;
    };

    const first = syncProfiles();
    const second = syncProfiles();
    const third = syncProfiles();
    assert.equal(fetches, 1, "joiners share the in-flight drain");

    pending.resolve({ activeId: "p1", profiles: [testProfile("p1")] });
    await Promise.all([first, second, third]);
    assert.equal(fetches, 1);
    assert.equal(store.lastStateRevision, 3);
    assert.equal(store.profilesLoaded, true);
    assert.equal(store.activeProfileId, "p1");
    assert.equal(store.profiles.length, 1);
  });

  it("does not fetch when profiles already match the adopted revision", async () => {
    adoptDaemonStatus(statusAt(5));
    store.profilesLoaded = true;
    store.lastStateRevision = 5;
    let fetches = 0;
    api.getProfiles = async () => {
      fetches += 1;
      return { activeId: null, profiles: [] };
    };

    await syncProfiles();
    assert.equal(fetches, 0);
  });

  it("refetches within the same sync when the revision advances mid-flight", async () => {
    adoptDaemonStatus(statusAt(3));
    const fetches: Array<ReturnType<typeof deferredValue<ProfilesResponse>>> = [];
    api.getProfiles = () => {
      const pending = deferredValue<ProfilesResponse>();
      fetches.push(pending);
      return pending.promise;
    };

    const sync = syncProfiles();
    const joined = syncProfiles();
    assert.equal(fetches.length, 1);

    adoptDaemonStatus(statusAt(4));
    fetches[0]?.resolve({ activeId: null, profiles: [testProfile("stale")] });
    await tick();
    assert.equal(fetches.length, 2, "the moved revision triggers another fetch in one drain");

    fetches[1]?.resolve({ activeId: "fresh", profiles: [testProfile("fresh")] });
    await Promise.all([sync, joined]);
    assert.equal(store.lastStateRevision, 4);
    assert.equal(store.activeProfileId, "fresh");
    assert.equal(profilesSyncNeeded(), false);
  });

  it("drops a response from before a daemon restart and resyncs the new boot", async () => {
    adoptDaemonStatus(statusAt(3, "boot-a"));
    const fetches: Array<ReturnType<typeof deferredValue<ProfilesResponse>>> = [];
    api.getProfiles = () => {
      const pending = deferredValue<ProfilesResponse>();
      fetches.push(pending);
      return pending.promise;
    };

    const sync = syncProfiles();
    assert.equal(fetches.length, 1);

    adoptDaemonStatus(statusAt(7, "boot-b"));
    fetches[0]?.resolve({ activeId: "old-boot", profiles: [testProfile("old-boot")] });
    await tick();
    assert.equal(fetches.length, 2, "the new boot's revision is fetched next");
    assert.equal(store.profiles.length, 0, "old-boot response was never adopted");
    assert.equal(store.profilesLoaded, false);

    fetches[1]?.resolve({ activeId: "p-b", profiles: [testProfile("p-b")] });
    await sync;
    assert.equal(store.activeProfileId, "p-b");
    assert.equal(store.lastStateRevision, 7);
    assert.equal(store.profilesLoaded, true);
  });

  it("propagates fetch failures to callers and recovers on the next sync", async () => {
    adoptDaemonStatus(statusAt(2));
    const failure = new Error("profiles unavailable");
    let fetches = 0;
    api.getProfiles = async () => {
      fetches += 1;
      if (fetches === 1) throw failure;
      return { activeId: null, profiles: [testProfile("x")] };
    };

    await assert.rejects(syncProfiles(), (error) => error === failure);
    assert.equal(store.profilesLoaded, false);
    assert.equal(profilesSyncNeeded(), true, "a failed sync stays due");

    await syncProfiles();
    assert.equal(fetches, 2);
    assert.equal(store.profilesLoaded, true);
    assert.equal(store.profiles.length, 1);
  });
});
