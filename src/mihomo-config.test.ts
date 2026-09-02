import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDefaultConfig,
  isValidMihomoConfig,
  overlayManagedKeys,
  parseContentDispositionFilename,
  parseSafeHttpUrl,
  resolveSubscriptionRedirect,
  stripManagedKeys,
} from "./mihomo-config.js";
import type { SashSettings } from "./settings.js";

describe("mihomo-config", () => {
  const mockSettings: SashSettings = {
    schemaVersion: 1,
    subscriptionUrl: "",
    mixedPort: 7890,
    controller: "127.0.0.1:9090",
    secret: "test-secret-1234",
    tun: false,
    allowLan: false,
    daemonPort: 19090,
    daemonSecret: "test-daemon-secret-1234",
    systemProxy: false,
  };

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
      assert.equal(isValidMihomoConfig({ "proxy-providers": null }), false);
      assert.equal(isValidMihomoConfig({ "proxy-providers": [] }), false);
    });
  });

  describe("parseSafeHttpUrl", () => {
    it("accepts only valid http(s) URLs", () => {
      assert.equal(parseSafeHttpUrl("https://example.com/path"), "https://example.com/path");
      assert.equal(parseSafeHttpUrl("http://example.com"), "http://example.com/");
      assert.equal(parseSafeHttpUrl("javascript:alert(1)"), undefined);
      assert.equal(parseSafeHttpUrl("not a url"), undefined);
    });
  });

  describe("subscription metadata and redirects", () => {
    it("removes terminal control characters from Content-Disposition filenames", () => {
      assert.equal(
        parseContentDispositionFilename('attachment; filename="plan\r\nnext.yaml"'),
        "plannext",
      );
      assert.equal(
        parseContentDispositionFilename("attachment; filename*=UTF-8''plan%00%7F.yaml"),
        "plan",
      );
    });

    it("rejects subscription HTTPS downgrades and redirects into restricted hosts", () => {
      const publicHttps = new URL("https://subscriptions.example/profile");
      assert.throws(
        () =>
          resolveSubscriptionRedirect(
            publicHttps,
            publicHttps,
            "http://subscriptions.example/next",
          ),
        /HTTPS-to-HTTP/,
      );
      const publicHttp = new URL("http://subscriptions.example/profile");
      assert.throws(
        () => resolveSubscriptionRedirect(publicHttp, publicHttp, "http://127.0.0.1:9090/private"),
        /restricted host/,
      );
      for (const target of [
        "http://[::ffff:127.0.0.1]/private",
        "http://[::7f00:1]/private",
        "http://[::ffff:0:7f00:1]/private",
        "http://[64:ff9b::7f00:1]/private",
        "http://[2002:7f00:1::]/private",
        "http://[fc00::1]/private",
        "http://[fe80::1]/private",
        "http://[fec0::1]/private",
        "http://[ff02::1]/private",
        "http://[2001:db8::1]/private",
      ]) {
        assert.throws(
          () => resolveSubscriptionRedirect(publicHttp, publicHttp, target),
          /restricted host/,
          target,
        );
      }
      assert.doesNotThrow(() =>
        resolveSubscriptionRedirect(publicHttp, publicHttp, "http://[2606:4700:4700::1111]/next"),
      );
      assert.doesNotThrow(() =>
        resolveSubscriptionRedirect(publicHttp, publicHttp, "http://203.0.1.10/next"),
      );
      const loopback = new URL("http://127.0.0.1:9090/profile");
      assert.throws(
        () => resolveSubscriptionRedirect(loopback, loopback, "http://localhost:9090/private"),
        /restricted origin/,
      );
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
        schemaVersion: 1,
        subscriptionUrl: "https://example.com/sub",
        mixedPort: 7890,
        controller: "127.0.0.1:9090",
        secret: "managed-secret",
        tun: false,
        allowLan: false,
        daemonPort: 19090,
        daemonSecret: "daemon-secret",
        systemProxy: false,
      };

      const overlaid = overlayManagedKeys(subscriptionBase, settings);

      // Overwritten / managed keys
      assert.equal(overlaid["mixed-port"], 7890);
      assert.equal(overlaid["allow-lan"], false);
      assert.equal(overlaid["external-controller"], "127.0.0.1:9090");
      assert.equal(overlaid.secret, "managed-secret");
      assert.equal("external-ui" in overlaid, false);
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

    it("strips every managed operational key without changing profile routing content", () => {
      const stripped = stripManagedKeys({
        "mixed-port": 7890,
        port: 8080,
        "external-controller": "127.0.0.1:9090",
        secret: "secret",
        tun: { enable: true },
        "allow-lan": true,
        proxies: [{ name: "node" }],
        rules: ["MATCH,DIRECT"],
      });

      assert.deepEqual(stripped, {
        proxies: [{ name: "node" }],
        rules: ["MATCH,DIRECT"],
      });
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
});
