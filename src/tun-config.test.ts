import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { enforceTunConfiguration } from "./tun-config.js";
import { defaultTunSettings } from "./tun-settings.js";

describe("tun-config", () => {
  describe("enforceTunConfiguration", () => {
    it("enforces the Sash TUN setting after generation hooks", () => {
      const config = { tun: { enable: true, stack: "system" } };
      enforceTunConfiguration(config, defaultTunSettings());
      assert.deepEqual(config.tun, { enable: false, stack: "system" });
      const warnings: string[] = [];
      const stripped: Record<string, unknown> = { listeners: [{ type: "tun" }, { type: "http" }] };
      enforceTunConfiguration(stripped, defaultTunSettings(), warnings);
      assert.deepEqual(stripped.listeners, [{ type: "http" }]);
      assert.ok(warnings.some((w) => w.includes("TUN listeners")));
    });

    it("re-applies the complete enabled TUN policy after generation hooks", () => {
      const tun = {
        ...defaultTunSettings(),
        enable: true,
        stack: "gvisor" as const,
        device: "sash-tun",
        dnsHijack: ["tcp://any:53"],
        routeExcludeAddress: ["192.168.0.0/16"],
      };
      const config: Record<string, unknown> = {
        tun: {
          enable: false,
          stack: "system",
          "auto-route": false,
          mtu: 1400,
          "dns-hijack": ["any:53"],
          "route-exclude-address": ["10.0.0.0/8"],
        },
        dns: { enable: false, nameserver: ["1.1.1.1"] },
      };
      const warnings: string[] = [];
      enforceTunConfiguration(config, tun, warnings);
      assert.deepEqual(config.tun, {
        enable: true,
        stack: "gvisor",
        "auto-route": true,
        "strict-route": false,
        "auto-detect-interface": true,
        device: "sash-tun",
        mtu: 1400,
        "dns-hijack": ["any:53", "tcp://any:53"],
        "route-exclude-address": ["10.0.0.0/8", "192.168.0.0/16"],
      });
      assert.deepEqual(config.dns, {
        listen: "127.0.0.1:1053",
        "enhanced-mode": "fake-ip",
        enable: true,
        nameserver: ["1.1.1.1"],
      });
      assert.ok(warnings.some((w) => w.includes("tun.stack")));
      assert.ok(warnings.some((w) => w.includes("dns.enable")));
    });
  });
});
