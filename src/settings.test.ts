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

  function writeSettingsText(text: string): void {
    fs.mkdirSync(path.dirname(layout.settingsFile), { recursive: true });
    fs.writeFileSync(layout.settingsFile, text);
  }

  function completeSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...DEFAULT_SETTINGS,
      secret: "test-core-secret",
      daemonSecret: "test-daemon-secret",
      ...overrides,
    };
  }

  function assertLoadRejectsWithoutOverwrite(text: string, pattern: RegExp): void {
    writeSettingsText(text);
    assert.throws(() => loadSettings(layout), pattern);
    assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), text);
  }

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
      assert.equal(first.schemaVersion, 1);
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
      writeSettingsText(JSON.stringify({ secret: "old-secret", mixedPort: 7891 }));

      const loaded = loadSettings(layout);
      assert.equal(loaded.schemaVersion, 1);
      assert.equal(loaded.secret, "old-secret");
      assert.equal(loaded.mixedPort, 7891);
      assert.equal(loaded.daemonPort, DEFAULT_SETTINGS.daemonPort);
      assert.equal(loaded.systemProxy, false);
      assert.ok(loaded.daemonSecret.length > 0);
    });

    it("rejects blank persisted secrets without overwriting them", () => {
      const text = JSON.stringify(completeSettings({ secret: "", daemonSecret: "" }));
      assertLoadRejectsWithoutOverwrite(text, /secret must not be blank/);
    });

    it("rejects every managed listener port collision without overwriting settings", () => {
      for (const overrides of [
        { mixedPort: 19090 },
        { controller: "127.0.0.1:17890" },
        { controller: "127.0.0.1:19090" },
      ]) {
        const text = JSON.stringify(completeSettings(overrides));
        assertLoadRejectsWithoutOverwrite(text, /must use different ports/);
      }
    });

    it("canonicalizes loopback controllers and rejects non-loopback settings", () => {
      writeSettingsText(JSON.stringify(completeSettings({ controller: " LOCALHOST:9090 " })));
      assert.equal(loadSettings(layout).controller, "localhost:9090");
      const canonical = JSON.parse(fs.readFileSync(layout.settingsFile, "utf8")) as {
        controller: string;
      };
      assert.equal(canonical.controller, "localhost:9090");

      const remote = JSON.stringify(completeSettings({ controller: "controller.example:9090" }));
      assertLoadRejectsWithoutOverwrite(remote, /loopback host:port/);
    });

    it("rejects corrupted sash.json without overwriting it", () => {
      const corrupt = "{ corrupted invalid json content @#$%! ]]";
      assertLoadRejectsWithoutOverwrite(corrupt, /Settings file is invalid JSON/);
    });

    it("rejects non-object JSON roots without overwriting them", () => {
      for (const text of ["null", "[]", '"settings"', "42"]) {
        assertLoadRejectsWithoutOverwrite(text, /JSON root must be a plain object/);
      }
    });

    it("rejects null fields, wrong field types, and invalid port ranges", () => {
      const fields = [
        "schemaVersion",
        "subscriptionUrl",
        "mixedPort",
        "controller",
        "secret",
        "tun",
        "allowLan",
        "daemonPort",
        "daemonSecret",
        "systemProxy",
      ];
      for (const field of fields) {
        const text = JSON.stringify(completeSettings({ [field]: null }));
        assertLoadRejectsWithoutOverwrite(text, /must not be null/);
      }

      const invalidDocuments: Array<{ name: string; document: Record<string, unknown> }> = [
        { name: "schemaVersion string", document: completeSettings({ schemaVersion: "1" }) },
        { name: "subscriptionUrl number", document: completeSettings({ subscriptionUrl: 123 }) },
        { name: "mixedPort string", document: completeSettings({ mixedPort: "17890" }) },
        { name: "mixedPort zero", document: completeSettings({ mixedPort: 0 }) },
        { name: "mixedPort above range", document: completeSettings({ mixedPort: 65_536 }) },
        { name: "mixedPort fractional", document: completeSettings({ mixedPort: 17890.5 }) },
        {
          name: "invalid controller",
          document: completeSettings({ controller: "not-a-controller" }),
        },
        { name: "secret number", document: completeSettings({ secret: 123 }) },
        { name: "tun string", document: completeSettings({ tun: "false" }) },
        { name: "allowLan number", document: completeSettings({ allowLan: 0 }) },
        { name: "daemonPort string", document: completeSettings({ daemonPort: "19090" }) },
        { name: "daemonPort zero", document: completeSettings({ daemonPort: 0 }) },
        { name: "daemonSecret boolean", document: completeSettings({ daemonSecret: false }) },
        { name: "systemProxy string", document: completeSettings({ systemProxy: "true" }) },
      ];

      for (const { document } of invalidDocuments) {
        const text = JSON.stringify(document);
        assertLoadRejectsWithoutOverwrite(text, /Settings are invalid/);
      }
    });

    it("rejects unknown fields without overwriting the file", () => {
      const text = JSON.stringify(completeSettings({ unexpected: true }));
      assertLoadRejectsWithoutOverwrite(text, /unknown field/);
    });

    it("rejects future schema versions without overwriting the file", () => {
      const text = JSON.stringify(completeSettings({ schemaVersion: 2 }));
      assertLoadRejectsWithoutOverwrite(text, /future version/);
    });

    it("migrates v0 and historical fields to canonical v1 settings", () => {
      writeSettingsText(
        JSON.stringify(
          completeSettings({
            schemaVersion: 0,
            subscriptionUrl: "https://example.test/legacy",
            coreVersion: "v1.0.0",
            uiVersion: "v2.0.0",
          }),
        ),
      );

      const loaded = loadSettings(layout);
      assert.equal(loaded.schemaVersion, 1);
      assert.equal(loaded.subscriptionUrl, "https://example.test/legacy");
      assert.equal(Object.hasOwn(loaded, "coreVersion"), false);
      assert.equal(Object.hasOwn(loaded, "uiVersion"), false);

      const persisted = JSON.parse(fs.readFileSync(layout.settingsFile, "utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(persisted.schemaVersion, 1);
      assert.equal(persisted.subscriptionUrl, "https://example.test/legacy");
      assert.equal(Object.hasOwn(persisted, "coreVersion"), false);
      assert.equal(Object.hasOwn(persisted, "uiVersion"), false);
      assert.deepEqual(Object.keys(persisted).sort(), [
        "allowLan",
        "controller",
        "daemonPort",
        "daemonSecret",
        "mixedPort",
        "schemaVersion",
        "secret",
        "subscriptionUrl",
        "systemProxy",
        "tun",
      ]);
    });
  });

  describe("publicSettings", () => {
    it("omits schema and secrets from API-safe settings", () => {
      const settings: SashSettings = {
        ...DEFAULT_SETTINGS,
        secret: "core-secret",
        daemonSecret: "daemon-secret",
      };
      const exposed = publicSettings(settings) as Record<string, unknown>;
      assert.equal("schemaVersion" in exposed, false);
      assert.equal("secret" in exposed, false);
      assert.equal("daemonSecret" in exposed, false);
      assert.equal(exposed.mixedPort, DEFAULT_SETTINGS.mixedPort);
    });
  });

  describe("applyManagedKey", () => {
    it("returns immutable boolean candidates", () => {
      const settings = { ...DEFAULT_SETTINGS, secret: "core", daemonSecret: "daemon" };
      const tun = applyManagedKey(settings, "tun", "on");
      assert.equal(settings.tun, false);
      assert.equal(tun.tun, true);
      const proxy = applyManagedKey(tun, "system-proxy", "1");
      assert.equal(proxy.systemProxy, true);
      assert.equal(applyManagedKey(proxy, "allow-lan", "off").allowLan, false);
    });

    it("applies mixed-port with strict validation", () => {
      const settings = { ...DEFAULT_SETTINGS, secret: "core", daemonSecret: "daemon" };
      const candidate = applyManagedKey(settings, "mixed-port", "10808");
      assert.equal(candidate.mixedPort, 10808);
      assert.equal(settings.mixedPort, DEFAULT_SETTINGS.mixedPort);
      assert.throws(() => applyManagedKey(settings, "mixed-port", "0x10"), /invalid port/);
      assert.throws(() => applyManagedKey(settings, "mixed-port", "70000"), /invalid port/);
    });

    it("regenerates the controller secret on demand", () => {
      const settings = { ...DEFAULT_SETTINGS, secret: "fixed", daemonSecret: "daemon" };
      const candidate = applyManagedKey(settings, "secret", "regenerate");
      assert.equal(settings.secret, "fixed");
      assert.notEqual(candidate.secret, "fixed");
      assert.equal(candidate.secret.length, 48);
      assert.throws(() => applyManagedKey(settings, "secret", "   "), /must not be blank/);
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
        schemaVersion: 1,
        subscriptionUrl: "https://example.com/subscription.yaml",
        mixedPort: 10808,
        controller: "127.0.0.1:9999",
        secret: "custom-secret-key-12345",
        tun: true,
        allowLan: true,
        daemonPort: 27890,
        daemonSecret: "custom-daemon-secret-67890",
        systemProxy: true,
      };

      saveSettings(customSettings, layout);

      assert.equal(fs.existsSync(layout.settingsFile), true);
      const raw = fs.readFileSync(layout.settingsFile, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      assert.deepEqual(parsed, customSettings);

      const loaded = loadSettings(layout);
      assert.deepEqual(loaded, customSettings);
      assert.deepEqual(saveSettings(customSettings, layout), JSON.parse(raw));
    });

    it("rejects incomplete or invalid settings without overwriting an existing file", () => {
      const valid: SashSettings = {
        ...DEFAULT_SETTINGS,
        secret: "existing-secret",
        daemonSecret: "existing-daemon-secret",
      };
      saveSettings(valid, layout);
      const original = fs.readFileSync(layout.settingsFile, "utf8");

      const incomplete = {
        mixedPort: 17890,
      } as unknown as SashSettings;
      assert.throws(() => saveSettings(incomplete, layout), /schemaVersion is required/);
      assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), original);

      const invalid = {
        ...valid,
        mixedPort: 0,
      } as unknown as SashSettings;
      assert.throws(() => saveSettings(invalid, layout), /mixedPort must be an integer/);
      assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), original);

      const unknownField = {
        ...valid,
        unexpected: true,
      };
      assert.throws(() => saveSettings(unknownField, layout), /unknown field/);
      assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), original);
    });

    it("drops historical fields when saving canonical settings", () => {
      const settingsWithHistory = {
        ...DEFAULT_SETTINGS,
        secret: "core-secret",
        daemonSecret: "daemon-secret",
        coreVersion: "v1.0.0",
        uiVersion: "v2.0.0",
      };
      saveSettings(settingsWithHistory, layout);

      const parsed = JSON.parse(fs.readFileSync(layout.settingsFile, "utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(Object.hasOwn(parsed, "coreVersion"), false);
      assert.equal(Object.hasOwn(parsed, "uiVersion"), false);
      assert.equal(parsed.schemaVersion, 1);
    });
  });
});
