import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type SashLayout, sashLayout } from "./paths.js";
import { migrateLegacyProfileSetting } from "./profile-migration.js";
import { loadProfiles } from "./profiles.js";
import { DEFAULT_SETTINGS, loadSettings, type SashSettings, saveSettings } from "./settings.js";

describe("legacy profile migration", () => {
  let tmpDir: string;
  let layout: SashLayout;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-profile-migration-test-"));
    layout = sashLayout(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("migrates the legacy URL once and removes it from sash.json", () => {
    const settings: SashSettings = {
      ...DEFAULT_SETTINGS,
      subscriptionUrl: "https://example.test/legacy",
      secret: "secret",
      daemonSecret: "daemon-secret",
    };
    saveSettings(settings, layout);

    assert.equal(migrateLegacyProfileSetting(settings, layout), true);
    const index = loadProfiles(layout);
    assert.equal(index.profiles.length, 1);
    assert.equal(index.activeId, index.profiles[0]?.id);
    assert.equal(index.profiles[0]?.url, "https://example.test/legacy");
    assert.equal("subscriptionUrl" in loadSettings(layout), false);
    assert.equal(migrateLegacyProfileSetting(settings, layout), false);
  });
});
