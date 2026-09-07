import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  defaultManagedStateFileOperations,
  recoverManagedStateTransaction,
} from "./managed-state-transaction.js";
import { buildDefaultConfig, renderConfig } from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import {
  IMPORTED_CONFIG_PROFILE_NAME,
  migrateLegacyProfileSetting,
  migrateProfileState,
  migrateUnmanagedConfig,
} from "./profile-migration.js";
import { loadProfiles, profileFilePath, saveProfiles } from "./profiles.js";
import { DEFAULT_SETTINGS, loadSettings, type SashSettings, saveSettings } from "./settings.js";

const USER_CONFIG = `mixed-port: 7890
external-controller: 0.0.0.0:9090
secret: legacy-secret
proxies:
  - name: user-node
    type: direct
proxy-groups:
  - name: USER
    type: select
    proxies:
      - user-node
rules:
  - MATCH,USER
`;

function settings(overrides: Partial<SashSettings> = {}): SashSettings {
  return {
    ...DEFAULT_SETTINGS,
    secret: "secret",
    daemonSecret: "daemon-secret",
    ...overrides,
  };
}

function encoded(data: string | null): string | null {
  return data === null ? null : Buffer.from(data).toString("base64");
}

describe("profile migrations", () => {
  let tmpDir: string;
  let layout: SashLayout;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-profile-migration-test-"));
    layout = sashLayout(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports a valid unmanaged config once as the active local profile without rewriting it", async () => {
    fs.writeFileSync(layout.configFile, USER_CONFIG);

    assert.equal(await migrateUnmanagedConfig(layout), true);

    const index = loadProfiles(layout);
    assert.equal(index.profiles.length, 1);
    assert.equal(index.activeId, index.profiles[0]?.id);
    assert.equal(index.profiles[0]?.name, IMPORTED_CONFIG_PROFILE_NAME);
    assert.equal(index.profiles[0]?.url, "");
    assert.equal(index.profiles[0]?.intervalHours, 0);
    assert.equal(
      fs.readFileSync(profileFilePath(layout, index.profiles[0]?.id ?? ""), "utf8"),
      USER_CONFIG,
    );
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), USER_CONFIG);
  });

  it("fails closed on malformed or invalid config without overwriting it", async () => {
    for (const content of ["proxies: [\n", "mode: rule\ndns:\n  enable: true\n"]) {
      fs.writeFileSync(layout.configFile, content);
      await assert.rejects(() => migrateUnmanagedConfig(layout), /left unchanged/);
      assert.equal(fs.readFileSync(layout.configFile, "utf8"), content);
      assert.equal(fs.existsSync(layout.profilesIndexFile), false);
    }
  });

  it("treats any existing profiles index, including an empty one, as an opt-out", async () => {
    saveProfiles({ activeId: null, profiles: [] }, layout);
    fs.writeFileSync(layout.configFile, USER_CONFIG);

    assert.equal(await migrateUnmanagedConfig(layout), false);
    assert.deepEqual(loadProfiles(layout), { activeId: null, profiles: [] });
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), USER_CONFIG);
  });

  it("does not import the exact generated DIRECT-only default after managed keys are stripped", async () => {
    const generated = renderConfig(buildDefaultConfig(), settings(), "default").yaml;
    fs.writeFileSync(layout.configFile, generated);

    assert.equal(await migrateUnmanagedConfig(layout), false);
    assert.equal(fs.existsSync(layout.profilesIndexFile), false);
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), generated);
  });

  it("is idempotent after a successful import", async () => {
    fs.writeFileSync(layout.configFile, USER_CONFIG);
    assert.equal(await migrateUnmanagedConfig(layout), true);
    const first = loadProfiles(layout);

    assert.equal(await migrateUnmanagedConfig(layout), false);
    assert.deepEqual(loadProfiles(layout), first);
    assert.equal(
      fs.readdirSync(layout.profilesDir).filter((file) => file.endsWith(".yaml")).length,
      1,
    );
  });

  it("rolls profile publication back when the index cannot be published", async () => {
    fs.writeFileSync(layout.configFile, USER_CONFIG);
    await assert.rejects(
      () =>
        migrateUnmanagedConfig(layout, {
          ...defaultManagedStateFileOperations,
          write: (file, data) => {
            if (file === layout.profilesIndexFile) throw new Error("index write failed");
            defaultManagedStateFileOperations.write(file, data);
          },
        }),
      /index write failed/,
    );

    assert.equal(fs.existsSync(layout.profilesIndexFile), false);
    assert.equal(fs.existsSync(layout.managedStateTransactionFile), false);
    assert.equal(
      fs.existsSync(layout.profilesDir) &&
        fs.readdirSync(layout.profilesDir).some((file) => file.endsWith(".yaml")),
      false,
    );
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), USER_CONFIG);
  });

  it("can import after startup recovery removes a partially published migration", async () => {
    const crashedId = "123";
    fs.mkdirSync(layout.profilesDir, { recursive: true });
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.configFile, USER_CONFIG);
    fs.writeFileSync(profileFilePath(layout, crashedId), USER_CONFIG);
    fs.writeFileSync(
      layout.profilesIndexFile,
      JSON.stringify({ activeId: crashedId, profiles: [] }),
    );
    fs.writeFileSync(
      layout.managedStateTransactionFile,
      JSON.stringify({
        version: 2,
        phase: "publishing",
        createdAt: "2026-01-01T00:00:00.000Z",
        index: { data: encoded(null) },
        profile: { id: crashedId, data: encoded(null) },
      }),
    );

    recoverManagedStateTransaction(layout);
    assert.equal(await migrateUnmanagedConfig(layout), true);
    assert.equal(loadProfiles(layout).profiles.length, 1);
    assert.equal(fs.existsSync(profileFilePath(layout, crashedId)), false);
  });

  it("gives a nonblank legacy subscription URL priority over unmanaged config", async () => {
    const current = settings({ subscriptionUrl: "https://example.test/legacy" });
    saveSettings(current, layout);
    fs.writeFileSync(layout.configFile, USER_CONFIG);

    const result = await migrateProfileState(current, layout);

    assert.deepEqual(result, { legacySubscription: true, unmanagedConfig: false });
    const index = loadProfiles(layout);
    assert.equal(index.profiles.length, 1);
    assert.equal(index.activeId, index.profiles[0]?.id);
    assert.equal(index.profiles[0]?.url, "https://example.test/legacy");
    assert.equal(fs.existsSync(profileFilePath(layout, index.profiles[0]?.id ?? "")), false);
    assert.equal("subscriptionUrl" in current, false);
    assert.equal("subscriptionUrl" in loadSettings(layout), false);
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), USER_CONFIG);
  });

  it("migrates the legacy URL transactionally once", async () => {
    const current = settings({ subscriptionUrl: "https://example.test/legacy" });
    saveSettings(current, layout);

    assert.equal(await migrateLegacyProfileSetting(current, layout), true);
    assert.equal(await migrateLegacyProfileSetting(current, layout), false);
    assert.equal(loadProfiles(layout).profiles.length, 1);
  });
});
