import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSystemProxySupported, runCmd } from "./common.js";
import { snapshotsCompatible, snapshotsEquivalent } from "./snapshot.js";
import { DEFAULT_BYPASS_LIST } from "./types.js";
import {
  createWindowsTarget,
  formatWindowsBypass,
  parseWindowsRegistryProxyValues,
  windowsState,
} from "./windows.js";

describe("sysproxy", () => {
  describe("helper child environment", () => {
    it("does not forward GitHub or npm credentials", async () => {
      const previousGithub = process.env.GITHUB_TOKEN;
      const previousNpm = process.env.NPM_TOKEN;
      try {
        process.env.GITHUB_TOKEN = "github-secret";
        process.env.NPM_TOKEN = "npm-secret";
        const output = await runCmd(process.execPath, [
          "-e",
          "process.stdout.write(JSON.stringify({ github: process.env.GITHUB_TOKEN, npm: process.env.NPM_TOKEN }))",
        ]);
        assert.deepEqual(JSON.parse(output), {});
      } finally {
        if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = previousGithub;
        if (previousNpm === undefined) delete process.env.NPM_TOKEN;
        else process.env.NPM_TOKEN = previousNpm;
      }
    });
  });

  describe("isSystemProxySupported", () => {
    it("enables desktop integration only on Windows", () => {
      assert.equal(isSystemProxySupported("win32"), true);
      assert.equal(isSystemProxySupported("darwin"), false);
    });

    it("reports false on unsupported platforms", () => {
      assert.equal(isSystemProxySupported("freebsd" as NodeJS.Platform), false);
      assert.equal(isSystemProxySupported("sunos" as NodeJS.Platform), false);
    });
  });

  describe("Windows registry helpers", () => {
    it("formats the default bypass list with semicolons", () => {
      const formatted = formatWindowsBypass(DEFAULT_BYPASS_LIST);
      assert.ok(formatted.includes("localhost"));
      assert.ok(formatted.includes("<local>"));
      assert.ok(formatted.includes("127.*"));
    });

    it("preserves spaces in REG_SZ values and distinguishes missing values", () => {
      const sample = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    proxy host.example:7890
    ProxyOverride    REG_SZ    <local>; localhost; 10.*
    AutoConfigURL    REG_SZ    https://pac.example.test/proxy.pac
    AutoDetect    REG_DWORD    0x1
`;
      const parsed = parseWindowsRegistryProxyValues(sample);
      assert.equal(parsed.proxyEnable, 1);
      assert.equal(parsed.proxyServer, "proxy host.example:7890");
      assert.equal(parsed.proxyOverride, "<local>; localhost; 10.*");
      assert.equal(parsed.autoConfigUrl, "https://pac.example.test/proxy.pac");
      assert.equal(parsed.autoDetect, 1);

      const missing = parseWindowsRegistryProxyValues(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0
`);
      assert.deepEqual(missing, {
        proxyEnable: 0,
        proxyServer: null,
        proxyOverride: null,
        autoConfigUrl: null,
        autoDetect: null,
      });
    });

    it("ignores trailing subkey listings from reg query", () => {
      // A whole-key `reg query` prints the key's own values first, then the
      // flush-left paths of its subkeys (always present under Internet Settings).
      const header =
        "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
      const parsed = parseWindowsRegistryProxyValues(
        `\r\n${header}\r\n` +
          "    ProxyEnable    REG_DWORD    0x0\r\n" +
          "    ProxyServer    REG_SZ    127.0.0.1:7890\r\n" +
          "    ProxyOverride    REG_SZ    localhost;<local>\r\n" +
          "\r\n" +
          `${header}\\5.0\r\n` +
          `${header}\\Cache\r\n` +
          `${header}\\Connections\r\n`,
      );
      assert.equal(parsed.proxyEnable, 0);
      assert.equal(parsed.proxyServer, "127.0.0.1:7890");
      assert.equal(parsed.proxyOverride, "localhost;<local>");
    });

    it("fails closed for empty, unrelated, truncated, and wrong registry responses", () => {
      const header =
        "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
      for (const output of [
        "",
        `${header}\n    MigrateProxy    REG_DWORD    0x1\n`,
        `${header}\n    ProxyEnable    REG_DWORD\n`,
        "HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\n    ProxyEnable    REG_DWORD    0x1\n",
        `${header}\n    ProxyEnable    REG_DWORD    0x1\nGARBAGE\n`,
        `${header}\n    ProxyEnable    REG_DWORD    0x1\n${header}\n`,
      ]) {
        assert.throws(
          () => parseWindowsRegistryProxyValues(output),
          /Invalid Windows registry output/,
        );
      }
    });
  });

  describe("Windows snapshot ownership", () => {
    it("recognizes only original and target leaf values as compatible", () => {
      const original = {
        version: 1 as const,
        platform: "win32" as const,
        proxyEnable: 0,
        proxyServer: "proxy-a.example.test:8000",
        proxyOverride: "<local>",
        autoConfigUrl: "https://pac.example.test/a.pac",
        autoDetect: 1,
      };
      const target = {
        version: 1 as const,
        platform: "win32" as const,
        proxyEnable: 1,
        proxyServer: "127.0.0.1:17890",
        proxyOverride: "<local>;localhost",
        autoConfigUrl: null,
        autoDetect: 0,
      };
      const partial = { ...original, proxyServer: target.proxyServer };
      const thirdParty = { ...partial, proxyOverride: "proxy-b.example.test" };

      assert.equal(snapshotsEquivalent(original, { ...original }), true);
      assert.equal(snapshotsCompatible(partial, original, target), true);
      assert.equal(snapshotsCompatible(thirdParty, original, target), false);

      // The flat AutoDetect value is rewritten by Windows on WinINet refreshes,
      // so it is excluded from ownership equivalence and compatibility.
      assert.equal(snapshotsEquivalent(target, { ...target, autoDetect: null }), true);
      assert.equal(snapshotsCompatible({ ...partial, autoDetect: null }, original, target), true);
      assert.equal(snapshotsCompatible({ ...partial, autoDetect: 0 }, original, target), true);
    });

    it("leaves the unmanaged Windows AutoDetect value out of targets", () => {
      const target = createWindowsTarget({ port: 17890 });
      assert.equal(target.platform, "win32");
      assert.equal(target.autoDetect, null);
      assert.equal(target.proxyEnable, 1);
      assert.equal(target.proxyServer, "127.0.0.1:17890");
      assert.equal(target.proxyOverride, DEFAULT_BYPASS_LIST.join(";"));
      assert.equal(target.autoConfigUrl, null);
    });

    it("normalizes custom endpoints and bypass lists when creating targets", () => {
      const target = createWindowsTarget({
        host: "::1",
        port: 17890,
        bypass: ["localhost", "<local>"],
      });
      assert.equal(target.proxyServer, "[::1]:17890");
      assert.equal(target.proxyOverride, "localhost;<local>");
    });

    it("reports manual, PAC, and AutoDetect state from typed snapshots", () => {
      const target = createWindowsTarget({ port: 17890 });
      assert.deepEqual(windowsState(target), {
        supported: true,
        enabled: true,
        server: "127.0.0.1:17890",
      });
      assert.deepEqual(windowsState({ ...target, proxyServer: null }), {
        supported: true,
        enabled: true,
        details: "manual proxy has no server",
      });
      assert.deepEqual(
        windowsState({
          ...target,
          proxyEnable: 0,
          autoConfigUrl: "https://pac.example.test/proxy.pac",
          autoDetect: 1,
        }),
        {
          supported: true,
          enabled: true,
          server: "https://pac.example.test/proxy.pac",
          details: "automatic proxy configuration is enabled",
        },
      );
      assert.deepEqual(windowsState({ ...target, proxyEnable: 0, autoDetect: 1 }), {
        supported: true,
        enabled: true,
        details: "automatic proxy detection is enabled",
      });
      assert.deepEqual(windowsState({ ...target, proxyEnable: 0 }), {
        supported: true,
        enabled: false,
      });
    });
  });
});
