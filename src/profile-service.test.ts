import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { defaultManagedStateFileOperations } from "./managed-state-transaction.js";
import type { SubscriptionFetch } from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { ProfileService } from "./profile-service.js";
import { addProfile, loadProfiles, profileFilePath, setActiveProfile } from "./profiles.js";
import { DEFAULT_SETTINGS, type SashSettings } from "./settings.js";

const yamlA = "proxies:\n  - name: node-a\n    type: direct\nrules:\n  - MATCH,DIRECT\n";
const yamlB = "proxies:\n  - name: node-b\n    type: direct\nrules:\n  - MATCH,DIRECT\n";

function fetched(yamlText: string, name = "remote"): SubscriptionFetch {
  return {
    doc: { proxies: [{ name: yamlText === yamlA ? "node-a" : "node-b", type: "direct" }] },
    yamlText,
    name,
    intervalHours: 6,
    subInfo: { upload: 1, download: 2, total: 100 },
    homePage: "https://example.test/",
  };
}

describe("ProfileService", () => {
  let tmpDir: string;
  let layout: SashLayout;
  let settings: SashSettings;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-profile-service-test-"));
    layout = sashLayout(tmpDir);
    settings = {
      ...DEFAULT_SETTINGS,
      secret: "test-secret",
      daemonSecret: "test-daemon-secret",
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores remote metadata and auto-activates only the first profile", async () => {
    const service = new ProfileService({
      layout,
      settings: () => settings,
      fetchProfile: async (url) => fetched(url.endsWith("a") ? yamlA : yamlB),
    });

    const first = await service.addRemote("https://example.test/a");
    const second = await service.addRemote("https://example.test/b");

    assert.equal(first.activated, true);
    assert.equal(second.activated, false);
    assert.equal(service.list().activeId, first.profile.id);
    assert.equal(first.profile.intervalHours, 6);
    assert.equal(first.profile.subInfo?.total, 100);
    assert.equal(first.profile.homePage, "https://example.test/");
    assert.match(fs.readFileSync(layout.configFile, "utf8"), /node-a/);
  });

  it("validates the final managed config before storing an imported profile", async () => {
    let validatedYaml = "";
    const service = new ProfileService({
      layout,
      settings: () => settings,
      validateConfig: (generated) => {
        validatedYaml = generated.yaml;
        throw new Error("core validation rejected");
      },
    });

    await assert.rejects(() => service.importLocal("invalid", yamlA), /core validation rejected/);
    assert.match(validatedYaml, /mixed-port: 17890/);
    assert.equal(service.list().profiles.length, 0);
    assert.equal(fs.existsSync(layout.configFile), false);
  });

  it("rolls config and active selection back when runtime reload fails", async () => {
    const service = new ProfileService({
      layout,
      settings: () => settings,
      reloadConfig: async (configPath) => {
        if (fs.readFileSync(configPath, "utf8").includes("node-b")) {
          throw new Error("reload rejected");
        }
      },
    });

    const first = await service.importLocal("first", yamlA);
    const second = await service.importLocal("second", yamlB);
    await assert.rejects(() => service.activate(second.profile.id), /reload rejected/);

    assert.equal(service.list().activeId, first.profile.id);
    assert.match(fs.readFileSync(layout.configFile, "utf8"), /node-a/);
  });

  it("rejects a missing local profile file instead of silently keeping old config", async () => {
    const service = new ProfileService({ layout, settings: () => settings });
    const first = await service.importLocal("first", yamlA);
    const second = await service.importLocal("second", yamlB);
    fs.rmSync(profileFilePath(layout, second.profile.id));

    await assert.rejects(() => service.activate(second.profile.id), /file is missing/);
    assert.equal(service.list().activeId, first.profile.id);
    assert.match(fs.readFileSync(layout.configFile, "utf8"), /node-a/);
  });

  it("leaves no profile state when first remote activation reload fails", async () => {
    const service = new ProfileService({
      layout,
      settings: () => settings,
      fetchProfile: async () => fetched(yamlA),
      reloadConfig: async () => {
        throw new Error("reload rejected");
      },
    });

    await assert.rejects(() => service.addRemote("https://example.test/a"), /reload rejected/);
    assert.deepEqual(service.list(), { activeId: null, profiles: [] });
    assert.equal(fs.existsSync(layout.configFile), false);
    assert.equal(fs.existsSync(layout.profilesDir), true);
    assert.equal(fs.readdirSync(layout.profilesDir).length, 0);
  });

  it("leaves no profile state when first local activation reload fails", async () => {
    const service = new ProfileService({
      layout,
      settings: () => settings,
      reloadConfig: async () => {
        throw new Error("reload rejected");
      },
    });

    await assert.rejects(() => service.importLocal("local", yamlA), /reload rejected/);
    assert.deepEqual(service.list(), { activeId: null, profiles: [] });
    assert.equal(fs.existsSync(layout.configFile), false);
    assert.equal(fs.readdirSync(layout.profilesDir).length, 0);
  });

  it("does not persist fetched missing-profile content before validation or reload succeeds", async () => {
    const seeded = addProfile({ name: "remote", url: "https://example.test/a" }, layout).profile;
    setActiveProfile(seeded.id, layout);
    const validatorFailure = new ProfileService({
      layout,
      settings: () => settings,
      fetchProfile: async () => fetched(yamlA),
      validateConfig: () => {
        throw new Error("invalid candidate");
      },
    });

    await assert.rejects(() => validatorFailure.activate(seeded.id), /invalid candidate/);
    assert.equal(fs.existsSync(profileFilePath(layout, seeded.id)), false);
    assert.equal(loadProfiles(layout).profiles[0]?.updatedAt, "1970-01-01T00:00:00.000Z");

    const reloadFailure = new ProfileService({
      layout,
      settings: () => settings,
      fetchProfile: async () => fetched(yamlA),
      reloadConfig: async () => {
        throw new Error("reload rejected");
      },
    });
    await assert.rejects(() => reloadFailure.reloadActive(), /reload rejected/);
    assert.equal(fs.existsSync(profileFilePath(layout, seeded.id)), false);
    assert.equal(loadProfiles(layout).profiles[0]?.updatedAt, "1970-01-01T00:00:00.000Z");
  });

  it("reports a failed old-runtime reload during rollback", async () => {
    const seed = new ProfileService({ layout, settings: () => settings });
    const first = await seed.importLocal("first", yamlA);
    const second = await seed.importLocal("second", yamlB);
    const service = new ProfileService({
      layout,
      settings: () => settings,
      reloadConfig: async () => {
        throw new Error("reload unavailable");
      },
    });

    await assert.rejects(
      () => service.activate(second.profile.id),
      /config rollback reload failed: reload unavailable/,
    );
    assert.equal(loadProfiles(layout).activeId, first.profile.id);
    assert.match(fs.readFileSync(layout.configFile, "utf8"), /node-a/);
  });

  it("rolls inactive YAML publication back when index publication fails", async () => {
    const first = new ProfileService({
      layout,
      settings: () => settings,
      fetchProfile: async () => fetched(yamlA),
    });
    await first.addRemote("https://example.test/a");
    let indexWrites = 0;
    const service = new ProfileService({
      layout,
      settings: () => settings,
      fetchProfile: async () => fetched(yamlB),
      fileOperations: {
        ...defaultManagedStateFileOperations,
        write: (file, data) => {
          if (file === layout.profilesIndexFile && ++indexWrites === 1) {
            throw new Error("index write failed");
          }
          defaultManagedStateFileOperations.write(file, data);
        },
      },
    });

    await assert.rejects(() => service.addRemote("https://example.test/b"), /index write failed/);
    assert.equal(loadProfiles(layout).profiles.length, 1);
    assert.equal(
      fs.readdirSync(layout.profilesDir).filter((file) => file.endsWith(".yaml")).length,
      1,
    );
    assert.match(fs.readFileSync(layout.configFile, "utf8"), /node-a/);
  });

  it("rolls active deletion back when its YAML cannot be deleted", async () => {
    const seed = new ProfileService({
      layout,
      settings: () => settings,
      fetchProfile: async () => fetched(yamlA),
    });
    const created = await seed.addRemote("https://example.test/a");
    const beforeConfig = fs.readFileSync(layout.configFile, "utf8");
    const service = new ProfileService({
      layout,
      settings: () => settings,
      fileOperations: {
        ...defaultManagedStateFileOperations,
        remove: (file) => {
          if (file === profileFilePath(layout, created.profile.id)) {
            throw new Error("delete failed");
          }
          defaultManagedStateFileOperations.remove(file);
        },
      },
    });

    await assert.rejects(() => service.remove(created.profile.id), /delete failed/);
    assert.equal(loadProfiles(layout).activeId, created.profile.id);
    assert.equal(fs.existsSync(profileFilePath(layout, created.profile.id)), true);
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), beforeConfig);
  });

  it("rejects a prepared profile when managed settings change before commit", async () => {
    let releaseFetch: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let continueFetch: (() => void) | undefined;
    const fetchBlocked = new Promise<void>((resolve) => {
      continueFetch = resolve;
    });
    const service = new ProfileService({
      layout,
      settings: () => settings,
      fetchProfile: async () => {
        releaseFetch?.();
        await fetchBlocked;
        return fetched(yamlA);
      },
    });

    const adding = service.addRemote("https://example.test/a");
    await fetchStarted;
    settings.mixedPort = 18888;
    continueFetch?.();

    await assert.rejects(adding, /Settings changed while preparing/);
    assert.deepEqual(service.list(), { activeId: null, profiles: [] });
  });

  it("fetches independent update-all profiles concurrently and commits safely", async () => {
    const a = addProfile({ name: "a", url: "https://example.test/a", yamlText: yamlA }, layout);
    const b = addProfile({ name: "b", url: "https://example.test/b", yamlText: yamlA }, layout);
    let concurrent = 0;
    let maxConcurrent = 0;
    const service = new ProfileService({
      layout,
      settings: () => settings,
      fetchProfile: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent -= 1;
        return fetched(yamlB);
      },
    });

    const result = await service.updateAll();

    assert.equal(result.updated, 2);
    assert.equal(result.failed.length, 0);
    assert.equal(maxConcurrent, 2);
    assert.match(fs.readFileSync(profileFilePath(layout, a.profile.id), "utf8"), /node-b/);
    assert.match(fs.readFileSync(profileFilePath(layout, b.profile.id), "utf8"), /node-b/);
    assert.equal(loadProfiles(layout).profiles.length, 2);
  });
});
