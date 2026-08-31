import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import YAML from "yaml";
import {
  buildDefaultConfig,
  configExists,
  generateConfig,
  isValidMihomoConfig,
  overlayManagedKeys,
} from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import type { SashSettings } from "./settings.js";

describe("mihomo-config", () => {
  let tmpDir: string;
  let layout: SashLayout;
  const mockSettings: SashSettings = {
    subscriptionUrl: "",
    mixedPort: 7890,
    controller: "127.0.0.1:9090",
    secret: "test-secret-1234",
    tun: false,
    coreVersion: "v1.19.30",
    uiVersion: "",
    allowLan: false,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-config-test-"));
    layout = sashLayout(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  describe("isValidMihomoConfig", () => {
    it("returns true for objects with proxies, proxy-providers, or rules", () => {
      assert.equal(isValidMihomoConfig({ proxies: [] }), true);
      assert.equal(isValidMihomoConfig({ rules: ["MATCH,DIRECT"] }), true);
      assert.equal(isValidMihomoConfig({ "proxy-providers": { test: {} } }), true);
      assert.equal(isValidMihomoConfig({ proxies: [{ name: "node" }], rules: [] }), true);
    });

    it("returns false for non-objects, null, arrays, empty objects, and primitive types", () => {
      assert.equal(isValidMihomoConfig({}), false);
      assert.equal(isValidMihomoConfig(null), false);
      assert.equal(isValidMihomoConfig(undefined), false);
      assert.equal(isValidMihomoConfig([]), false);
      assert.equal(isValidMihomoConfig(["proxies"]), false);
      assert.equal(isValidMihomoConfig("str"), false);
      assert.equal(isValidMihomoConfig(12345), false);
      assert.equal(isValidMihomoConfig(true), false);
    });
  });

  describe("buildDefaultConfig", () => {
    it("returns valid default config object with DIRECT-only proxy group and MATCH rule", () => {
      const config = buildDefaultConfig();
      assert.equal(config.mode, "rule");
      assert.equal(config["log-level"], "info");
      assert.equal(config.ipv6, true);
      assert.deepEqual(config.proxies, []);
      assert.deepEqual(config["proxy-groups"], [
        { name: "PROXY", type: "select", proxies: ["DIRECT"] },
      ]);
      assert.deepEqual(config.rules, ["MATCH,PROXY"]);
    });
  });

  describe("overlayManagedKeys", () => {
    it("overrides managed keys while preserving unmanaged subscription keys", () => {
      const subscriptionBase: Record<string, unknown> = {
        "mixed-port": 1111,
        port: 2222,
        "socks-port": 3333,
        "external-controller": "0.0.0.0:1111",
        "external-ui": "old-ui",
        "external-ui-url": "https://example.com/ui.tar.gz",
        "external-ui-name": "old-ui-name",
        secret: "old-secret",
        "allow-lan": true,
        tun: { enable: false },
        mode: "rule",
        dns: { enable: true, nameserver: ["1.1.1.1"] },
        proxies: [{ name: "sub-node", type: "ss", server: "1.2.3.4", port: 443 }],
        rules: ["DOMAIN,example.com,DIRECT", "MATCH,PROXY"],
      };

      const settings: SashSettings = {
        subscriptionUrl: "https://example.com/sub",
        mixedPort: 7890,
        controller: "127.0.0.1:9090",
        secret: "managed-secret",
        tun: false,
        coreVersion: "",
        uiVersion: "",
        allowLan: false,
      };

      const overlaid = overlayManagedKeys(subscriptionBase, settings);

      // Overwritten / managed keys
      assert.equal(overlaid["mixed-port"], 7890);
      assert.equal(overlaid["allow-lan"], false);
      assert.equal(overlaid["external-controller"], "127.0.0.1:9090");
      assert.equal(overlaid["external-ui"], "ui");
      assert.equal(overlaid.secret, "managed-secret");
      assert.equal("port" in overlaid, false);
      assert.equal("socks-port" in overlaid, false);
      assert.equal("external-ui-url" in overlaid, false);
      assert.equal("external-ui-name" in overlaid, false);
      assert.equal("tun" in overlaid, false);

      // Preserved unmanaged keys
      assert.equal(overlaid.mode, "rule");
      assert.deepEqual(overlaid.dns, { enable: true, nameserver: ["1.1.1.1"] });
      assert.deepEqual(overlaid.proxies, [
        { name: "sub-node", type: "ss", server: "1.2.3.4", port: 443 },
      ]);
      assert.deepEqual(overlaid.rules, ["DOMAIN,example.com,DIRECT", "MATCH,PROXY"]);
    });

    it("generates tun config with enable and auto-route when tun is true", () => {
      const settings: SashSettings = { ...mockSettings, tun: true };
      const overlaid = overlayManagedKeys({}, settings);

      assert.deepEqual(overlaid.tun, {
        enable: true,
        stack: "mixed",
        "auto-route": true,
        "auto-detect-interface": true,
        "dns-hijack": ["any:53"],
      });
    });

    it("omits tun key entirely when tun is false", () => {
      const settings: SashSettings = { ...mockSettings, tun: false };
      const overlaid = overlayManagedKeys({ tun: { enable: true } }, settings);

      assert.equal("tun" in overlaid, false);
    });
  });

  describe("generateConfig & configExists", () => {
    it("generates default config to disk containing MATCH,PROXY and external-controller when no subscription provided", async () => {
      assert.equal(configExists(layout), false);

      const result = await generateConfig({ layout, settings: mockSettings });

      assert.equal(result.source, "default");
      assert.equal(result.proxyCount, 0);
      assert.ok(result.yaml.includes("MATCH,PROXY"));
      assert.ok(result.yaml.includes("external-controller: 127.0.0.1:9090"));

      assert.equal(configExists(layout), true);
      assert.equal(fs.existsSync(layout.configFile), true);

      const diskContent = fs.readFileSync(layout.configFile, "utf8");
      assert.equal(diskContent, result.yaml);

      const parsed = YAML.parse(diskContent) as Record<string, unknown>;
      assert.equal(parsed["mixed-port"], 7890);
      assert.equal(parsed["external-controller"], "127.0.0.1:9090");
      assert.equal(parsed.secret, mockSettings.secret);
      assert.deepEqual(parsed.rules, ["MATCH,PROXY"]);
    });

    it("generates config with subscription and reports accurate proxyCount", async () => {
      const subscription = {
        proxies: [
          { name: "Node A", type: "ss", server: "1.1.1.1", port: 8388 },
          { name: "Node B", type: "vmess", server: "2.2.2.2", port: 443 },
          { name: "Node C", type: "trojan", server: "3.3.3.3", port: 443 },
        ],
        rules: ["MATCH,DIRECT"],
      };

      const result = await generateConfig({
        layout,
        settings: mockSettings,
        subscription,
      });

      assert.equal(result.source, "subscription");
      assert.equal(result.proxyCount, 3);
      assert.equal(configExists(layout), true);

      const parsed = YAML.parse(fs.readFileSync(layout.configFile, "utf8")) as {
        proxies: unknown[];
        secret: string;
      };
      assert.equal(parsed.proxies.length, 3);
      assert.equal(parsed.secret, mockSettings.secret);
    });
  });
});
