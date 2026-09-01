import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type SashLayout, sashLayout } from "./paths.js";
import {
  applyManagedKey,
  DEFAULT_SETTINGS,
  generateSecret,
  loadSettings,
  publicSettings,
  requiresCoreRestart,
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

    it("generates and persists a daemon secret alongside the controller secret", () => {
      const first = loadSettings(layout);
      assert.ok(first.daemonSecret.length > 0, "daemonSecret should not be empty");
      assert.notEqual(first.daemonSecret, first.secret);
      const second = loadSettings(layout);
      assert.equal(second.daemonSecret, first.daemonSecret);
    });

    it("backfills new fields for settings files written by older versions", () => {
      fs.mkdirSync(path.dirname(layout.settingsFile), { recursive: true });
      fs.writeFileSync(
        layout.settingsFile,
        JSON.stringify({ secret: "old-secret", mixedPort: 7891 }),
      );
      const loaded = loadSettings(layout);
      assert.equal(loaded.secret, "old-secret");
      assert.equal(loaded.mixedPort, 7891);
      assert.equal(loaded.daemonPort, DEFAULT_SETTINGS.daemonPort);
      assert.equal(loaded.systemProxy, false);
      assert.ok(loaded.daemonSecret.length > 0);
    });

    it("rejects corrupted sash.json without overwriting it", () => {
      fs.mkdirSync(path.dirname(layout.settingsFile), { recursive: true });
      const corrupt = "{ corrupted invalid json content @#$%! ]]";
      fs.writeFileSync(layout.settingsFile, corrupt);

      assert.throws(() => loadSettings(layout), /Settings file is invalid JSON/);
      assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), corrupt);
    });
  });

  describe("publicSettings", () => {
    it("omits controller and daemon secrets from API-safe settings", () => {
      const settings: SashSettings = {
        ...DEFAULT_SETTINGS,
        secret: "core-secret",
        daemonSecret: "daemon-secret",
      };
      const exposed = publicSettings(settings) as Record<string, unknown>;
      assert.equal("secret" in exposed, false);
      assert.equal("daemonSecret" in exposed, false);
      assert.equal(exposed.mixedPort, DEFAULT_SETTINGS.mixedPort);
    });
  });

  describe("applyManagedKey", () => {
    it("applies boolean keys", () => {
      const settings = { ...DEFAULT_SETTINGS };
      applyManagedKey(settings, "tun", "on");
      assert.equal(settings.tun, true);
      applyManagedKey(settings, "system-proxy", "1");
      assert.equal(settings.systemProxy, true);
      applyManagedKey(settings, "allow-lan", "off");
      assert.equal(settings.allowLan, false);
    });

    it("applies mixed-port with strict validation", () => {
      const settings = { ...DEFAULT_SETTINGS };
      applyManagedKey(settings, "mixed-port", "10808");
      assert.equal(settings.mixedPort, 10808);
      assert.throws(() => applyManagedKey(settings, "mixed-port", "0x10"), /invalid port/);
      assert.throws(() => applyManagedKey(settings, "mixed-port", "70000"), /invalid port/);
    });

    it("regenerates the controller secret on demand", () => {
      const settings = { ...DEFAULT_SETTINGS, secret: "fixed" };
      applyManagedKey(settings, "secret", "regenerate");
      assert.notEqual(settings.secret, "fixed");
      assert.equal(settings.secret.length, 48);
    });

    it("rejects unknown keys", () => {
      const settings = { ...DEFAULT_SETTINGS };
      assert.throws(() => applyManagedKey(settings, "daemon-port", "1234"), /unknown key/);
    });
  });

  describe("requiresCoreRestart", () => {
    it("classifies listener/auth keys as restart-requiring", () => {
      for (const key of ["controller", "secret", "tun", "mixed-port", "allow-lan"]) {
        assert.equal(requiresCoreRestart(key), true, key);
      }
      assert.equal(requiresCoreRestart("system-proxy"), false);
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
        daemonPort: 27890,
        daemonSecret: "custom-daemon-secret-67890",
        systemProxy: true,
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
