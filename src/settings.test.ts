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
  parseControllerAddress,
  publicSettings,
  type SashSettings,
  sameSettings,
  saveSettings,
  validateSettingsCandidate,
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
        { controller: "127.0.0.1:7890" },
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

    it("does not rewrite an equivalent canonical document for formatting alone", () => {
      const document = completeSettings();
      const reversed = Object.fromEntries(Object.entries(document).reverse());
      const text = `${JSON.stringify(reversed, null, 4)}\n`;
      writeSettingsText(text);

      assert.deepEqual(loadSettings(layout), document);
      assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), text);
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
    it("projects only the explicit API-safe allowlist", () => {
      const settings: SashSettings = {
        ...DEFAULT_SETTINGS,
        subscriptionUrl: "https://example.test/private-source",
        secret: "core-secret",
        daemonSecret: "daemon-secret",
      };

      assert.deepEqual(publicSettings(settings), {
        mixedPort: DEFAULT_SETTINGS.mixedPort,
        controller: DEFAULT_SETTINGS.controller,
        tun: DEFAULT_SETTINGS.tun,
        allowLan: DEFAULT_SETTINGS.allowLan,
        daemonPort: DEFAULT_SETTINGS.daemonPort,
        systemProxy: DEFAULT_SETTINGS.systemProxy,
      });
    });
  });

  describe("sameSettings", () => {
    it("compares canonical values independently of property order", () => {
      const left: SashSettings = {
        ...DEFAULT_SETTINGS,
        subscriptionUrl: "https://example.test/sub",
        secret: "core",
        daemonSecret: "daemon",
      };
      const reordered: SashSettings = {
        systemProxy: left.systemProxy,
        daemonSecret: left.daemonSecret,
        daemonPort: left.daemonPort,
        allowLan: left.allowLan,
        tun: left.tun,
        secret: left.secret,
        controller: left.controller,
        mixedPort: left.mixedPort,
        subscriptionUrl: left.subscriptionUrl,
        schemaVersion: left.schemaVersion,
      };

      assert.equal(sameSettings(left, reordered), true);
      assert.equal(sameSettings(left, { ...reordered, mixedPort: 18888 }), false);
      assert.equal(sameSettings(left, { ...reordered, subscriptionUrl: undefined }), false);
    });
  });

  describe("validateSettingsCandidate", () => {
    it("returns immutable canonicalized candidates", () => {
      const settings = { ...DEFAULT_SETTINGS, secret: "core", daemonSecret: "daemon" };
      const candidate = validateSettingsCandidate({
        ...settings,
        tun: true,
        controller: " LOCALHOST:9091 ",
      });
      assert.equal(settings.tun, false);
      assert.equal(candidate.tun, true);
      assert.equal(candidate.controller, "localhost:9091");
    });

    it("rejects invalid ports, blank secrets and non-loopback controllers", () => {
      const settings = { ...DEFAULT_SETTINGS, secret: "core", daemonSecret: "daemon" };
      assert.throws(
        () => validateSettingsCandidate({ ...settings, mixedPort: 70_000 }),
        /mixedPort must be an integer from 1 to 65535/,
      );
      assert.throws(
        () => validateSettingsCandidate({ ...settings, secret: "   " }),
        /secret must not be blank/,
      );
      assert.throws(
        () => validateSettingsCandidate({ ...settings, controller: "controller.example:9090" }),
        /controller must be a loopback host:port controller address/,
      );
    });

    it("rejects port collisions across all three listeners", () => {
      const settings = { ...DEFAULT_SETTINGS, secret: "core", daemonSecret: "daemon" };
      assert.throws(
        () => validateSettingsCandidate({ ...settings, mixedPort: DEFAULT_SETTINGS.daemonPort }),
        /must use different ports/,
      );
    });
  });

  describe("parseControllerAddress", () => {
    it("accepts and canonicalizes loopback host:port addresses", () => {
      assert.deepEqual(parseControllerAddress("127.0.0.1:9090"), {
        host: "127.0.0.1",
        port: 9090,
        canonical: "127.0.0.1:9090",
      });
      assert.deepEqual(parseControllerAddress(" LOCALHOST:8080 "), {
        host: "localhost",
        port: 8080,
        canonical: "localhost:8080",
      });
      assert.deepEqual(parseControllerAddress("[::1]:9090"), {
        host: "::1",
        port: 9090,
        canonical: "[::1]:9090",
      });
    });

    it("rejects non-loopback and malformed addresses", () => {
      for (const value of [
        "0.0.0.0:80",
        "192.168.1.2:9090",
        "controller.example:9090",
        "127.0.0.1:0",
        "127.0.0.1:65536",
        "127.0.0.1",
        "",
        "   ",
        "host:abc",
        "[::1]",
        "host:9090/path",
        "host:9090?q=1",
        "user@host:9090",
        "host: 9090",
      ]) {
        assert.equal(parseControllerAddress(value), undefined, JSON.stringify(value));
      }
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
