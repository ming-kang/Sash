import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type SashLayout, sashLayout } from "./paths.js";
import { ProfileConflictError, ProfileService } from "./profile-service.js";
import {
  loadProfiles,
  NEVER_UPDATED,
  type ProfileMeta,
  profileFilePath,
  saveProfiles,
} from "./profiles.js";
import type { RuntimeLifecycle } from "./runtime-lifecycle.js";
import { DEFAULT_SETTINGS, loadSettings, type SashSettings, saveSettings } from "./settings.js";
import { SettingsService } from "./settings-service.js";
import type { CoreSupervisor } from "./supervisor.js";

function seedActiveRemote(layout: SashLayout, url: string): ProfileMeta {
  const profile: ProfileMeta = {
    id: "1",
    name: "remote",
    url,
    intervalHours: 24,
    createdAt: new Date().toISOString(),
    updatedAt: NEVER_UPDATED,
  };
  saveProfiles({ activeId: profile.id, profiles: [profile] }, layout);
  return profile;
}

const YAML_A = "proxies:\n  - name: node-a\n    type: direct\nrules:\n  - MATCH,DIRECT\n";
const YAML_B = "proxies:\n  - name: node-b\n    type: direct\nrules:\n  - MATCH,DIRECT\n";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function initialSettings(): SashSettings {
  return {
    ...DEFAULT_SETTINGS,
    secret: "core-secret",
    daemonSecret: "daemon-secret",
  };
}

describe("SettingsService", () => {
  let root: string;
  let layout: SashLayout;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-settings-service-test-"));
    layout = sashLayout(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses candidate runtime settings while public committed settings remain unchanged", async () => {
    let committed = saveSettings(initialSettings(), layout);
    let runtime = committed;
    let observedRuntimePort = 0;
    let observedCommittedPort = 0;
    const profiles = new ProfileService({ layout, settings: () => committed });
    const supervisor = {
      isRunning: () => true,
    } as unknown as CoreSupervisor;
    const lifecycle = {
      restart: async () => {
        observedRuntimePort = runtime.mixedPort;
        observedCommittedPort = committed.mixedPort;
        return { pid: 1234 };
      },
    } as unknown as RuntimeLifecycle;
    const service = new SettingsService({
      layout,
      getCommitted: () => committed,
      setCommitted: (next) => {
        committed = next;
      },
      setRuntime: (next) => {
        runtime = next;
      },
      profiles,
      supervisor,
      lifecycle,
      commit: async (_purpose, action) => action(),
    });

    await service.update("mixed-port", "18888");

    assert.equal(observedRuntimePort, 18888);
    assert.equal(observedCommittedPort, 17890);
    assert.equal(committed.mixedPort, 18888);
    assert.equal(loadSettings(layout).mixedPort, 18888);
  });

  it("gives direct and queued commit boundaries identical offline results", async () => {
    const run = async (queued: boolean): Promise<SashSettings> => {
      const localLayout = sashLayout(path.join(root, queued ? "queued" : "direct"));
      let committed = saveSettings(initialSettings(), localLayout);
      let runtime = committed;
      let tail = Promise.resolve();
      const service = new SettingsService({
        layout: localLayout,
        getCommitted: () => committed,
        setCommitted: (next) => {
          committed = next;
        },
        setRuntime: (next) => {
          runtime = next;
        },
        profiles: new ProfileService({ layout: localLayout, settings: () => committed }),
        commit: queued
          ? (_purpose, action) => {
              const next = tail.then(action, action);
              tail = next.then(
                () => undefined,
                () => undefined,
              );
              return next;
            }
          : async (_purpose, action) => action(),
      });
      await service.update("allow-lan", "on");
      assert.equal(runtime.allowLan, true);
      return loadSettings(localLayout);
    };

    assert.deepEqual(await run(false), await run(true));
  });

  it("persists a fetched missing active profile with the settings config transaction", async () => {
    let committed = saveSettings(initialSettings(), layout);
    let runtime = committed;
    const seeded = seedActiveRemote(layout, "https://example.test/profile");
    let profileChanges = 0;
    const service = new SettingsService({
      layout,
      getCommitted: () => committed,
      setCommitted: (next) => {
        committed = next;
      },
      setRuntime: (next) => {
        runtime = next;
      },
      profiles: new ProfileService({
        layout,
        settings: () => committed,
        fetchProfile: async () => ({
          doc: { rules: ["MATCH,DIRECT"] },
          yamlText: "rules:\n  - MATCH,DIRECT\n",
        }),
        onChange: () => {
          profileChanges++;
        },
      }),
      commit: async (_purpose, action) => action(),
    });

    await service.update("allow-lan", "on");

    assert.equal(runtime.allowLan, true);
    assert.equal(fs.existsSync(profileFilePath(layout, seeded.id)), true);
    assert.notEqual(loadProfiles(layout).profiles[0]?.updatedAt, "1970-01-01T00:00:00.000Z");
    assert.equal(profileChanges, 1);
    assert.match(fs.readFileSync(layout.configFile, "utf8"), /allow-lan: true/);
  });

  it("re-prepares settings when the active profile content changes before commit", async () => {
    let committed = saveSettings(initialSettings(), layout);
    let runtime = committed;
    const seeded = seedActiveRemote(layout, "https://example.test/profile");
    fs.mkdirSync(layout.profilesDir, { recursive: true });
    fs.writeFileSync(profileFilePath(layout, seeded.id), YAML_A);

    const settingsPrepareEntered = deferred();
    const releaseSettingsPrepare = deferred();
    let blockFirstSettingsPrepare = true;
    let commitTail = Promise.resolve();
    const commit = <T>(_purpose: string, action: () => T | Promise<T>): Promise<T> => {
      const next = commitTail.then(action, action);
      commitTail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };
    const profiles = new ProfileService({
      layout,
      settings: () => committed,
      fetchProfile: async () => ({
        doc: { proxies: [{ name: "node-b", type: "direct" }] },
        yamlText: YAML_B,
      }),
      validateConfig: async (generated) => {
        if (!generated.yaml.includes("allow-lan: true") || !blockFirstSettingsPrepare) return;
        blockFirstSettingsPrepare = false;
        settingsPrepareEntered.resolve();
        await releaseSettingsPrepare.promise;
      },
      commit,
    });
    const service = new SettingsService({
      layout,
      getCommitted: () => committed,
      setCommitted: (next) => {
        committed = next;
      },
      setRuntime: (next) => {
        runtime = next;
      },
      profiles,
      commit,
    });

    const updatingSettings = service.update("allow-lan", "on");
    await settingsPrepareEntered.promise;
    await profiles.update(seeded.id);
    assert.match(fs.readFileSync(layout.configFile, "utf8"), /node-b/);
    releaseSettingsPrepare.resolve();

    await updatingSettings;
    assert.equal(committed.allowLan, true);
    assert.equal(runtime.allowLan, true);
    assert.match(fs.readFileSync(profileFilePath(layout, seeded.id), "utf8"), /node-b/);
    const config = fs.readFileSync(layout.configFile, "utf8");
    assert.match(config, /node-b/);
    assert.match(config, /allow-lan: true/);
  });

  it("stops after one automatic profile-conflict retry", async () => {
    let committed = saveSettings(initialSettings(), layout);
    let runtime = committed;
    const profiles = new ProfileService({ layout, settings: () => committed });
    let assertions = 0;
    profiles.assertPreparedActiveCurrent = () => {
      assertions += 1;
      throw new ProfileConflictError("profile keeps changing");
    };
    const service = new SettingsService({
      layout,
      getCommitted: () => committed,
      setCommitted: (next) => {
        committed = next;
      },
      setRuntime: (next) => {
        runtime = next;
      },
      profiles,
      commit: async (_purpose, action) => action(),
    });

    await assert.rejects(() => service.update("allow-lan", "on"), /profile keeps changing/);
    assert.equal(assertions, 2);
    assert.equal(committed.allowLan, false);
    assert.equal(runtime.allowLan, false);
  });

  it("restores runtime settings when proxy-off publication fails", async () => {
    let committed = saveSettings({ ...initialSettings(), systemProxy: true }, layout);
    let runtime = committed;
    fs.mkdirSync(layout.managedStateTransactionFile, { recursive: true });
    const service = new SettingsService({
      layout,
      getCommitted: () => committed,
      setCommitted: (next) => {
        committed = next;
      },
      setRuntime: (next) => {
        runtime = next;
      },
      profiles: new ProfileService({ layout, settings: () => committed }),
      commit: async (_purpose, action) => action(),
    });

    await assert.rejects(() => service.update("system-proxy", "off"));

    assert.equal(runtime.systemProxy, true);
    assert.equal(committed.systemProxy, true);
    assert.equal(loadSettings(layout).systemProxy, true);
  });

  it("rolls back an online TUN enable when the Core remains inactive", async () => {
    let committed = saveSettings(initialSettings(), layout);
    let runtime = committed;
    let restartCalls = 0;
    const profiles = new ProfileService({ layout, settings: () => committed });
    const supervisor = {
      isRunning: () => true,
    } as unknown as CoreSupervisor;
    const lifecycle = {
      restart: async () => {
        restartCalls++;
        return { pid: 1234, tunActive: false };
      },
    } as unknown as RuntimeLifecycle;
    const service = new SettingsService({
      layout,
      getCommitted: () => committed,
      setCommitted: (next) => {
        committed = next;
      },
      setRuntime: (next) => {
        runtime = next;
      },
      profiles,
      supervisor,
      lifecycle,
      commit: async (_purpose, action) => action(),
    });

    await assert.rejects(
      () => service.update("tun", "on"),
      /TUN did not become active.*sash config set tun on.*sash restart/s,
    );

    assert.equal(restartCalls, 2);
    assert.equal(runtime.tun, false);
    assert.equal(committed.tun, false);
    assert.equal(loadSettings(layout).tun, false);
    assert.doesNotMatch(fs.readFileSync(layout.configFile, "utf8"), /^tun:/m);
  });

  it("disables system proxy even when the profile index is corrupt", async () => {
    let committed = saveSettings({ ...initialSettings(), systemProxy: true }, layout);
    let runtime = committed;
    fs.mkdirSync(layout.profilesDir, { recursive: true });
    fs.writeFileSync(layout.profilesIndexFile, "{ broken");
    let released = false;
    const service = new SettingsService({
      layout,
      getCommitted: () => committed,
      setCommitted: (next) => {
        committed = next;
      },
      setRuntime: (next) => {
        runtime = next;
      },
      profiles: new ProfileService({ layout, settings: () => committed }),
      releaseSystemProxy: async () => {
        released = true;
      },
      commit: async (_purpose, action) => action(),
    });

    await service.update("system-proxy", "off");

    assert.equal(released, true);
    assert.equal(committed.systemProxy, false);
    assert.equal(runtime.systemProxy, false);
    assert.equal(loadSettings(layout).systemProxy, false);
  });
});
