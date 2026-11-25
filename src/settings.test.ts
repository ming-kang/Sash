import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  generateSecret,
  initialSettings,
  parseControllerAddress,
  parseStoredSettings,
  publicSettings,
  validateSettingsCandidate,
} from "./settings.js";
import { testSettings } from "./testing/state.js";
import {
  applyTunPatch,
  defaultTunSettings,
  parseStoredTunSettings,
  tunSettingsPatchSchema,
  tunSettingsSchema,
} from "./tun-settings.js";

describe("settings boundaries", () => {
  it("does not migrate a legacy boolean or malformed TUN settings to enabled", () => {
    const settings = testSettings();
    for (const tun of [undefined, true, { enable: true, stack: "other" }])
      assert.equal(parseStoredSettings({ ...settings, tun }).tun.enable, false);
    assert.equal(parseStoredSettings({ ...settings, tun: { enable: true } }).tun.enable, true);
    assert.throws(() => validateSettingsCandidate({ ...settings, tun: true }));
  });
  it("separates stored TUN settings from patch deletion semantics", () => {
    assert.deepEqual(parseStoredTunSettings({ enable: true }), {
      ...defaultTunSettings(),
      enable: true,
    });
    assert.equal(tunSettingsPatchSchema.safeParse({ device: null }).success, true);
    assert.equal(tunSettingsSchema.safeParse({ device: null }).success, false);
    const settings = testSettings();
    assert.throws(() =>
      validateSettingsCandidate({ ...settings, tun: { ...settings.tun, device: null } }),
    );
  });
  it("merges TUN patches and removes a device without mutating the base", () => {
    const device = process.platform === "darwin" ? "utun7" : "sash-tun";
    const base = { ...defaultTunSettings(), enable: true, device };
    const cleared = applyTunPatch(base, { strictRoute: true, device: null });
    assert.equal(cleared.enable, true);
    assert.equal(cleared.strictRoute, true);
    assert.equal(cleared.device, undefined);
    assert.equal(base.device, device);
    assert.deepEqual(applyTunPatch(base, {}), base);
  });
  it("generates independent private credentials", () => {
    const settings = initialSettings();
    assert.match(generateSecret(), /^[a-f0-9]{48}$/);
    assert.notEqual(settings.secret, settings.daemonSecret);
    assert.equal("secret" in publicSettings(settings), false);
    assert.equal("daemonSecret" in publicSettings(settings), false);
  });
  it("canonicalizes loopback addresses without mutating the candidate", () => {
    const input = testSettings({ controller: " LOCALHOST:18991 " });
    assert.equal(validateSettingsCandidate(input).controller, "localhost:18991");
    assert.equal(input.controller, " LOCALHOST:18991 ");
    assert.equal(parseControllerAddress("[::1]:18781")?.host, "::1");
    for (const value of [
      "0.0.0.0:9090",
      "controller.example:90",
      "127.0.0.1:0",
      "127.0.0.1:65536",
      "127.0.0.1:01",
      "http://localhost:80",
      "localhost:80/path",
      "user@localhost:80",
    ])
      assert.equal(parseControllerAddress(value), undefined, value);
  });
  it("rejects wrong types, missing fields and unsafe credentials", () => {
    const input = testSettings();
    for (const value of [
      null,
      [],
      "settings",
      { mixedPort: 18000 },
      { ...input, secret: " " },
      { ...input, daemonSecret: "x\ny" },
    ])
      assert.throws(() => validateSettingsCandidate(value));
    for (const value of [0, -1, 65536, 1.5, Infinity, "1234", null])
      assert.throws(() => validateSettingsCandidate({ ...input, mixedPort: value }));
    for (const value of [0, "false", null])
      assert.throws(() => validateSettingsCandidate({ ...input, allowLan: value }));
  });
  it("rejects every pair of listener collisions", () => {
    const input = testSettings();
    for (const patch of [
      { mixedPort: input.daemonPort },
      { controller: `127.0.0.1:${input.mixedPort}` },
      { controller: `127.0.0.1:${input.daemonPort}` },
    ])
      assert.throws(() => validateSettingsCandidate({ ...input, ...patch }), /different ports/);
  });
});
