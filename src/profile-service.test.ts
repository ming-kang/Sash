import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SubscriptionFetch } from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { ProfileService } from "./profile-service.js";
import { addProfile, loadProfiles, profileFilePath } from "./profiles.js";
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
