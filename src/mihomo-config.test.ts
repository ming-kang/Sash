import assert from "node:assert/strict";
import { describe, it } from "node:test";
import YAML from "yaml";
import {
  asCoreConfigDocument,
  buildDefaultConfig,
  GEOX_MIRRORS,
  type GeneratedConfig,
  overlayManagedKeys,
  parseContentDispositionFilename,
  parseSafeHttpUrl,
  resolveSubscriptionRedirect,
  stripManagedKeys,
  withGeodataMirrors,
} from "./mihomo-config.js";
import type { SashSettings } from "./settings.js";

describe("mihomo-config", () => {
  const mockSettings: SashSettings = {
    mixedPort: 7890,
    controller: "127.0.0.1:9090",
    secret: "test-secret-1234",
    allowLan: false,
    daemonPort: 19090,
    daemonSecret: "test-daemon-secret-1234",
    systemProxy: false,
  };

  describe("asCoreConfigDocument", () => {
    it("accepts any non-array object and rejects every other document", () => {
      const document = { proxies: [] };
      assert.equal(asCoreConfigDocument(document), document);
      for (const value of [null, undefined, [], ["proxies"], "str", 12345, true]) {
        assert.throws(() => asCoreConfigDocument(value), /not a core configuration document/);
      }
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

    it("refuses redirect targets outside http(s)", () => {
      const current = new URL("https://subscriptions.example/profile");
      assert.throws(
        () => resolveSubscriptionRedirect(current, current, "ftp://subscriptions.example/next"),
        /non-http\(s\)/,
      );
      assert.throws(
        () => resolveSubscriptionRedirect(current, current, "file:///etc/passwd"),
        /non-http\(s\)/,
      );
      assert.equal(
        resolveSubscriptionRedirect(current, current, "/next").href,
        "https://subscriptions.example/next",
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

  describe("withGeodataMirrors", () => {
    it("sets all four mirror URLs while preserving the rest of the document", () => {
      const generated: GeneratedConfig = {
        yaml: [
          "mixed-port: 7890",
          "proxies:",
          "  - name: node-a",
          "    type: ss",
          "    server: 1.2.3.4",
          "    port: 443",
          'rules: ["DOMAIN,example.com,DIRECT", "MATCH,PROXY"]',
          "",
        ].join("\n"),
        proxyCount: 1,
        source: "subscription",
      };

      const rewritten = withGeodataMirrors(generated);
      const parsed = YAML.parse(rewritten.yaml) as Record<string, unknown>;

      assert.deepEqual(parsed["geox-url"], { ...GEOX_MIRRORS });
      assert.equal(parsed["mixed-port"], 7890);
      assert.deepEqual(parsed.proxies, [
        { name: "node-a", type: "ss", server: "1.2.3.4", port: 443 },
      ]);
      assert.deepEqual(parsed.rules, ["DOMAIN,example.com,DIRECT", "MATCH,PROXY"]);
      assert.equal(rewritten.proxyCount, 1);
      assert.equal(rewritten.source, "subscription");
    });

    it("overrides a profile-supplied geox-url", () => {
      const generated: GeneratedConfig = {
        yaml: [
          "mixed-port: 7890",
          "geox-url:",
          "  geoip: https://profile.example/geoip.dat",
          "  mmdb: https://profile.example/country.mmdb",
          "",
        ].join("\n"),
        proxyCount: 0,
        source: "subscription",
      };

      const parsed = YAML.parse(withGeodataMirrors(generated).yaml) as Record<string, unknown>;
      assert.deepEqual(parsed["geox-url"], { ...GEOX_MIRRORS });
      assert.equal(parsed["mixed-port"], 7890);
    });

    it("throws for a document that is not a core-config object", () => {
      for (const yaml of ["- one\n- two\n", "just a scalar\n", ""]) {
        assert.throws(
          () => withGeodataMirrors({ yaml, proxyCount: 0, source: "default" }),
          /not a core configuration document/,
        );
      }
    });
  });

  describe("overlayManagedKeys", () => {
    it("preserves DNS and provider options while disabling profile TUN without mutating input", () => {
      const profile = {
        tun: { enable: true, "auto-route": true },
        dns: { enable: false, nameserver: ["1.1.1.1"] },
        "proxy-groups": [{ name: "PROXY", type: "url-test", "expected-status": 204 }],
        "rule-providers": {
          remote: { type: "http", url: "https://example.test/rules", proxy: "PROXY" },
        },
      };
      const original = structuredClone(profile);
      const overlaid = overlayManagedKeys(profile, mockSettings);
      assert.deepEqual(profile, original);
      assert.deepEqual(overlaid.tun, { enable: false });
      assert.deepEqual(overlaid.dns, profile.dns);
      assert.deepEqual(overlaid["proxy-groups"], profile["proxy-groups"]);
      assert.deepEqual(overlaid["rule-providers"], profile["rule-providers"]);
    });

    it("overrides managed keys while preserving unmanaged subscription keys", () => {
      const subscriptionBase: Record<string, unknown> = {
        "mixed-port": 1111,
        port: 2222,
        "socks-port": 3333,
        "external-controller": "0.0.0.0:1111",
        "external-controller-tls": "0.0.0.0:2222",
        "external-controller-unix": "/tmp/controller.sock",
        "external-controller-pipe": "controller-pipe",
        tunnels: ["tcp,0.0.0.0:27894,example.com:80,DIRECT"],
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
        mixedPort: 7890,
        controller: "127.0.0.1:9090",
        secret: "managed-secret",
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
      assert.equal("external-controller-tls" in overlaid, false);
      assert.equal("external-controller-unix" in overlaid, false);
      assert.equal("external-controller-pipe" in overlaid, false);
      assert.equal("tunnels" in overlaid, false);
      assert.deepEqual(overlaid.tun, { enable: false });

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

    it("explicitly disables profile TUN in the generated runtime config", () => {
      const overlaid = overlayManagedKeys({ tun: { enable: true } }, mockSettings);

      assert.deepEqual(overlaid.tun, { enable: false });
    });
  });
});
