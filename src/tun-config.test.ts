import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { enforceTunConfiguration, tunDisabledDocument } from "./tun-config.js";
import { defaultTunSettings } from "./tun-settings.js";

describe("tun-config", () => {
  describe("tunDisabledDocument", () => {
    it("returns a copy with the TUN section reduced to disabled", () => {
      const config: Record<string, unknown> = {
        "mixed-port": 7890,
        tun: { enable: true, stack: "system", mtu: 1400 },
      };
      const disabled = tunDisabledDocument(config);
      assert.deepEqual(disabled, { "mixed-port": 7890, tun: { enable: false } });
      assert.deepEqual(config.tun, { enable: true, stack: "system", mtu: 1400 });
    });
  });

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
        ...(process.platform === "darwin" ? { "dns-mode": "native" } : {}),
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

  describe("system dns-mode default", () => {
    function withMockedPlatform<T>(platform: string, run: () => T): T {
      const original = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: platform });
      try {
        return run();
      } finally {
        if (original) Object.defineProperty(process, "platform", original);
      }
    }

    const enabledTun = () => ({ ...defaultTunSettings(), enable: true });

    it("defaults dns-mode to native on macOS when the profile does not pin it", () => {
      withMockedPlatform("darwin", () => {
        const config: Record<string, unknown> = { tun: { mtu: 1400 } };
        enforceTunConfiguration(config, enabledTun());
        assert.equal((config.tun as Record<string, unknown>)["dns-mode"], "native");
      });
    });

    it("respects a profile-pinned dns-mode on macOS", () => {
      withMockedPlatform("darwin", () => {
        const config: Record<string, unknown> = { tun: { "dns-mode": "hijack" } };
        enforceTunConfiguration(config, enabledTun());
        assert.equal((config.tun as Record<string, unknown>)["dns-mode"], "hijack");
      });
    });

    it("does not default dns-mode off macOS", () => {
      withMockedPlatform("win32", () => {
        const config: Record<string, unknown> = {};
        enforceTunConfiguration(config, enabledTun());
        assert.equal("dns-mode" in (config.tun as Record<string, unknown>), false);
      });
    });

    it("does not default dns-mode while TUN is disabled", () => {
      withMockedPlatform("darwin", () => {
        const config: Record<string, unknown> = {};
        enforceTunConfiguration(config, defaultTunSettings());
        assert.equal("dns-mode" in (config.tun as Record<string, unknown>), false);
      });
    });
  });
});
