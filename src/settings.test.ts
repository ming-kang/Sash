import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type SashLayout, sashLayout } from "./paths.js";
import {
  DEFAULT_SETTINGS,
  generateSecret,
  loadSettings,
  type SashSettings,
  saveSettings,
} from "./settings.js";

describe("settings", () => {
  let tmpDir: string;
  let layout: SashLayout;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-settings-test-"));
    layout = sashLayout(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  describe("generateSecret", () => {
    it("generates a 48-character hex string", () => {
      const secret = generateSecret();
      assert.equal(typeof secret, "string");
      assert.equal(secret.length, 48);
      assert.match(secret, /^[0-9a-f]{48}$/);
    });

    it("generates distinct secrets on successive calls", () => {
      const secret1 = generateSecret();
      const secret2 = generateSecret();
      assert.notEqual(secret1, secret2);
    });
  });

  describe("loadSettings", () => {
    it("generates and persists a secret on first load, returning the same secret on subsequent loads", () => {
      assert.equal(fs.existsSync(layout.settingsFile), false);

      const first = loadSettings(layout);
      assert.ok(first.secret.length > 0, "secret should not be empty");
      assert.equal(first.mixedPort, DEFAULT_SETTINGS.mixedPort);
      assert.equal(first.controller, DEFAULT_SETTINGS.controller);
      assert.equal(first.tun, DEFAULT_SETTINGS.tun);
      assert.equal(fs.existsSync(layout.settingsFile), true);

      const second = loadSettings(layout);
      assert.equal(second.secret, first.secret);
      assert.deepEqual(second, first);
    });

    it("falls back to default settings without throwing when sash.json is corrupted", () => {
      fs.mkdirSync(path.dirname(layout.settingsFile), { recursive: true });
      fs.writeFileSync(layout.settingsFile, "{ corrupted invalid json content @#$%! ]]");

      let settings: SashSettings | undefined;
      assert.doesNotThrow(() => {
        settings = loadSettings(layout);
      });

      assert.ok(settings);
      assert.equal(settings.mixedPort, DEFAULT_SETTINGS.mixedPort);
      assert.equal(settings.controller, DEFAULT_SETTINGS.controller);
      assert.equal(settings.tun, DEFAULT_SETTINGS.tun);
      assert.ok(settings.secret.length > 0);
    });
  });

  describe("saveSettings", () => {
    it("saves settings to disk and performs an exact round-trip", () => {
      const customSettings: SashSettings = {
        subscriptionUrl: "https://example.com/subscription.yaml",
        mixedPort: 10808,
        controller: "127.0.0.1:9999",
        secret: "custom-secret-key-12345",
        tun: true,
        coreVersion: "v1.19.30",
        uiVersion: "v2.5.0",
        allowLan: true,
      };

      saveSettings(customSettings, layout);

      assert.equal(fs.existsSync(layout.settingsFile), true);
      const raw = fs.readFileSync(layout.settingsFile, "utf8");
      const parsed = JSON.parse(raw);
      assert.deepEqual(parsed, customSettings);

      const loaded = loadSettings(layout);
      assert.deepEqual(loaded, customSettings);
    });
  });
});
