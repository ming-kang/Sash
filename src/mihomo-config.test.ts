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
  TunConfigError,
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

    it("preserves only validated advanced TUN fields and overrides operational fields", () => {
      for (const stack of ["mixed", "system", "gvisor"]) {
        for (const mtu of [576, 1500, 65535]) {
          for (const strictRoute of [true, false]) {
            const base = Object.freeze({
              tun: Object.freeze({
                enable: false,
                stack,
                mtu,
                "strict-route": strictRoute,
                "auto-route": false,
                "auto-detect-interface": false,
                "dns-hijack": ["tcp://any:53"],
                device: "profile-device",
                "file-descriptor": 42,
                "route-address": ["192.0.2.0/24"],
                "route-command": "do-not-run",
              }),
            });
            const original = structuredClone(base);
            assert.deepEqual(overlayManagedKeys(base, { ...mockSettings, tun: true }).tun, {
              enable: true,
              stack,
              mtu,
              "strict-route": strictRoute,
              "auto-route": true,
              "auto-detect-interface": true,
              "dns-hijack": ["any:53"],
            });
            assert.deepEqual(base, original);
          }
        }
      }
    });

    it("uses the existing preset for absent advanced fields", () => {
      const preset = overlayManagedKeys({}, { ...mockSettings, tun: true }).tun;
      for (const tun of [{}, { enable: false }]) {
        assert.deepEqual(overlayManagedKeys({ tun }, { ...mockSettings, tun: true }).tun, preset);
      }
      assert.deepEqual(
        overlayManagedKeys({ tun: { "strict-route": true } }, { ...mockSettings, tun: true }).tun,
        { ...(preset as Record<string, unknown>), "strict-route": true },
      );
    });

    it("rejects malformed TUN and invalid advanced values only when enabling", () => {
      const invalidTun = [
        undefined,
        null,
        [],
        "auto",
        true,
        1,
        ...[undefined, null, "Mixed", "unknown", 1, [], {}].map((stack) => ({ stack })),
        ...[undefined, null, "1500", 575, 65536, 1500.5, NaN, Infinity, true].map((mtu) => ({
          mtu,
        })),
        ...[undefined, null, "true", 0, 1, [], {}].map((value) => ({ "strict-route": value })),
      ];
      for (const tun of invalidTun) {
        const base = { tun };
        const original = structuredClone(base);
        assert.throws(
          () => overlayManagedKeys(base, { ...mockSettings, tun: true }),
          TunConfigError,
        );
        assert.equal("tun" in overlayManagedKeys(base, mockSettings), false);
        assert.deepEqual(base, original);
      }
    });

    it("preserves the synthetic reference profile's advanced TUN and exact DNS block", () => {
      const base = {
        rules: ["MATCH,DIRECT"],
        tun: {
          enable: true,
          stack: "mixed",
          "strict-route": true,
          "dns-hijack": ["any:53", "tcp://any:53"],
          "auto-route": true,
          "auto-detect-interface": true,
        },
        dns: {
          enable: true,
          "enhanced-mode": "fake-ip",
          "respect-rules": true,
          nameserver: ["https://resolver.example/dns-query"],
          "proxy-server-nameserver": ["https://bootstrap.example/dns-query"],
          "fake-ip-filter": ["*.example.com", "service.example.net"],
        },
      };
      const original = structuredClone(base);
      for (const enable of [true, false]) {
        const profile = { ...base, tun: { ...base.tun, enable } };
        const overlaid = overlayManagedKeys(profile, { ...mockSettings, tun: true });
        assert.deepEqual(overlaid.tun, {
          enable: true,
          stack: "mixed",
          "strict-route": true,
          "auto-route": true,
          "auto-detect-interface": true,
          "dns-hijack": ["any:53"],
        });
        assert.deepEqual(overlaid.dns, original.dns);
        assert.deepEqual(profile.tun, { ...original.tun, enable });
      }
      assert.deepEqual(base, original);
    });

    it("adds minimal DNS defaults only for a DNS-less TUN profile", () => {
      for (const ipv6 of [undefined, true, false]) {
        const base = { ...buildDefaultConfig(), ...(ipv6 === undefined ? {} : { ipv6 }) };
        const original = structuredClone(base);
        Object.freeze(base);
        const overlaid = overlayManagedKeys(base, { ...mockSettings, tun: true });
        assert.deepEqual(overlaid.dns, {
          enable: true,
          ipv6: ipv6 !== false,
          "enhanced-mode": "redir-host",
          nameserver: ["https://cloudflare-dns.com/dns-query", "https://dns.google/dns-query"],
          "default-nameserver": ["1.1.1.1", "8.8.8.8"],
        });
        assert.deepEqual(base, original);
      }
      assert.equal(
        (overlayManagedKeys({}, { ...mockSettings, tun: true }).dns as Record<string, unknown>)
          .ipv6,
        true,
      );
    });

    it("preserves enabled custom DNS exactly without mutating the source", () => {
      const dns = Object.freeze({
        enable: true,
        ipv6: false,
        listen: "127.0.0.1:15353",
        "enhanced-mode": "fake-ip",
        nameserver: ["https://resolver.example/dns-query"],
        "nameserver-policy": { "example.com": ["192.0.2.1"] },
        "fake-ip-filter": ["*.lan"],
      });
      const base = Object.freeze({ dns });
      const original = structuredClone(base);
      const overlaid = overlayManagedKeys(base, { ...mockSettings, tun: true });
      assert.deepEqual(overlaid.dns, original.dns);
      assert.deepEqual(base, original);
    });

    it("only adds enable to custom DNS when omitted", () => {
      for (const dns of [{}, { nameserver: ["192.0.2.1"], "use-hosts": false }]) {
        const base = Object.freeze({ dns: Object.freeze(dns) });
        const original = structuredClone(base);
        const overlaid = overlayManagedKeys(base, { ...mockSettings, tun: true });
        assert.deepEqual(overlaid.dns, { ...dns, enable: true });
        assert.deepEqual(base, original);
      }
    });

    it("rejects explicitly disabled DNS with actionable TUN guidance", () => {
      const base = Object.freeze({ dns: Object.freeze({ enable: false }) });
      assert.throws(() => overlayManagedKeys(base, { ...mockSettings, tun: true }), {
        name: "TunConfigError",
        message: "Enable profile DNS before using TUN or disable TUN.",
      });
      assert.deepEqual(base, { dns: { enable: false } });
    });

    it("rejects malformed DNS and nonboolean enable values for TUN", () => {
      for (const dns of [
        null,
        undefined,
        [],
        "auto",
        true,
        1,
        ...[null, undefined, "true", "false", 0, 1, [], {}].map((enable) => ({ enable })),
      ]) {
        const base = { dns };
        const original = structuredClone(base);
        assert.throws(
          () => overlayManagedKeys(base, { ...mockSettings, tun: true }),
          TunConfigError,
        );
        assert.deepEqual(base, original);
      }
    });

    it("leaves all DNS input untouched and adds no DNS defaults when TUN is off", () => {
      assert.equal("dns" in overlayManagedKeys(buildDefaultConfig(), mockSettings), false);
      for (const dns of [undefined, null, [], "auto", { enable: false }, { enable: "true" }, {}]) {
        const base = { dns };
        const original = structuredClone(base);
        assert.deepEqual(overlayManagedKeys(base, mockSettings).dns, dns);
        assert.deepEqual(base, original);
      }
    });

    it("omits tun key entirely when tun is false", () => {
      const settings: SashSettings = { ...mockSettings, tun: false };
      const overlaid = overlayManagedKeys({ tun: { enable: true } }, settings);

      assert.equal("tun" in overlaid, false);
    });
  });
});
