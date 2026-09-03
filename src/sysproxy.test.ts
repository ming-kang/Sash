import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCmd } from "./sysproxy/common.js";
import {
  createLegacyProxyCleanup,
  createSystemProxyBackend,
  DEFAULT_BYPASS_LIST,
  disableLegacySystemProxyIfOwned,
  formatWindowsBypass,
  isSystemProxySnapshot,
  isSystemProxySupported,
  parseDarwinAutoProxySetting,
  parseDarwinProxySetting,
  parseDarwinServices,
  parseGSettingsPort,
  parseGSettingsString,
  parseSystemProxySnapshot,
  parseWindowsRegistryProxyValues,
  SYSTEM_PROXY_SNAPSHOT_VERSION,
} from "./sysproxy.js";

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
    it("reports true on win32 and darwin", () => {
      assert.equal(isSystemProxySupported("win32"), true);
      assert.equal(isSystemProxySupported("darwin"), true);
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

  describe("macOS networksetup helpers", () => {
    it("parses active network services filtering asterisks", () => {
      const sample = `
An asterisk (*) denotes that a network service is disabled.
Wi-Fi
*Bluetooth PAN
Thunderbolt Bridge
`;
      const services = parseDarwinServices(sample);
      assert.deepEqual(services, ["Wi-Fi", "Thunderbolt Bridge"]);
    });

    it("parses authenticated proxy state for snapshots", () => {
      const sample = `
Enabled: Yes
Server: proxy.example.test
Port: 8080
Authenticated Proxy Enabled: 1
`;
      assert.deepEqual(parseDarwinProxySetting(sample), {
        enabled: true,
        server: "proxy.example.test",
        port: 8080,
        authenticated: true,
      });
    });

    it("parses automatic proxy URL state for snapshots", () => {
      assert.deepEqual(
        parseDarwinAutoProxySetting("URL: https://pac.example.test/proxy.pac\nEnabled: Yes\n"),
        { enabled: true, url: "https://pac.example.test/proxy.pac" },
      );
      assert.deepEqual(parseDarwinAutoProxySetting("URL: (null)\nEnabled: No\n"), {
        enabled: false,
        url: "",
      });
    });

    it("keeps empty Server and URL values on their own lines", () => {
      const manual = `Enabled: Yes
Server:
Port: 0
Authenticated Proxy Enabled: 0
`;
      assert.deepEqual(parseDarwinProxySetting(manual), {
        enabled: true,
        server: "",
        port: 0,
        authenticated: false,
      });
      assert.deepEqual(parseDarwinAutoProxySetting("URL:\nEnabled: No\n"), {
        enabled: false,
        url: "",
      });
    });
  });

  describe("snapshot and gsettings parsers", () => {
    it("parses escaped GVariant strings and typed uint16 ports", () => {
      assert.equal(parseGSettingsString("'proxy\\\\name\\'s'\n"), "proxy\\name's");
      assert.throws(() => parseGSettingsString("manual"), /single-quoted/);
      assert.equal(parseGSettingsPort("uint16 17890\n", "test port"), 17890);
      assert.equal(parseGSettingsPort("1080", "test port"), 1080);
    });

    it("keeps snapshot APIs available through the public entry", () => {
      const snapshot = {
        version: SYSTEM_PROXY_SNAPSHOT_VERSION,
        platform: "linux" as const,
        mode: "none" as const,
        autoConfigUrl: "",
        httpUseAuthentication: false,
        http: { host: "", port: 0 },
        https: { host: "", port: 0 },
        socks: { host: "", port: 0 },
      };
      assert.equal(isSystemProxySnapshot(snapshot), true);
      assert.equal(typeof disableLegacySystemProxyIfOwned, "function");
      const backend = createSystemProxyBackend("freebsd" as NodeJS.Platform);
      assert.deepEqual(backend.state(snapshot), {
        supported: false,
        enabled: false,
        details: "unsupported platform: freebsd",
      });
    });

    it("rejects unknown snapshot fields", () => {
      assert.throws(
        () =>
          parseSystemProxySnapshot({
            version: 1,
            platform: "linux",
            mode: "none",
            autoConfigUrl: "",
            httpUseAuthentication: false,
            http: { host: "", port: 0 },
            https: { host: "", port: 0 },
            socks: { host: "", port: 0 },
            extra: true,
          }),
        /unexpected fields/,
      );
    });

    it("builds legacy cleanup only for an exact Sash loopback target", () => {
      const windows = {
        version: 1 as const,
        platform: "win32" as const,
        proxyEnable: 1,
        proxyServer: "127.0.0.1:17890",
        proxyOverride: "<local>",
        autoConfigUrl: "https://pac.example.test/proxy.pac",
        autoDetect: 1,
      };
      assert.deepEqual(createLegacyProxyCleanup(windows, { port: 17890 }), {
        ...windows,
        proxyEnable: 0,
      });
      assert.equal(createLegacyProxyCleanup(windows, { port: 17891 }), undefined);

      const linux = {
        version: 1 as const,
        platform: "linux" as const,
        mode: "manual" as const,
        autoConfigUrl: "",
        httpUseAuthentication: false,
        http: { host: "127.0.0.1", port: 17890 },
        https: { host: "127.0.0.1", port: 17890 },
        socks: { host: "127.0.0.1", port: 17890 },
      };
      assert.deepEqual(createLegacyProxyCleanup(linux, { port: 17890 }), {
        ...linux,
        mode: "none",
      });
    });

    it("recognizes only original and target leaf values as compatible", () => {
      const backend = createSystemProxyBackend("win32");
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

      assert.equal(backend.equivalent(original, { ...original }), true);
      assert.equal(backend.compatible(partial, original, target), true);
      assert.equal(backend.compatible(thirdParty, original, target), false);

      // The flat AutoDetect value is rewritten by Windows on WinINet refreshes,
      // so it is excluded from ownership equivalence and compatibility.
      assert.equal(backend.equivalent(target, { ...target, autoDetect: null }), true);
      assert.equal(backend.compatible({ ...partial, autoDetect: null }, original, target), true);
      assert.equal(backend.compatible({ ...partial, autoDetect: 0 }, original, target), true);
    });

    it("leaves the unmanaged Windows AutoDetect value out of targets", () => {
      const backend = createSystemProxyBackend("win32");
      const original = {
        version: 1 as const,
        platform: "win32" as const,
        proxyEnable: 0,
        proxyServer: null,
        proxyOverride: null,
        autoConfigUrl: null,
        autoDetect: 1,
      };
      const target = backend.createTarget(original, { port: 17890 });
      assert.equal(target.platform, "win32");
      if (target.platform !== "win32") return;
      assert.equal(target.autoDetect, null);
      assert.equal(target.proxyEnable, 1);
      assert.equal(target.proxyServer, "127.0.0.1:17890");
    });
  });
});
