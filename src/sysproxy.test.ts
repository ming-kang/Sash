import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLegacyProxyCleanup,
  createSystemProxyBackend,
  DEFAULT_BYPASS_LIST,
  formatWindowsBypass,
  isSystemProxySupported,
  parseDarwinAutoProxySetting,
  parseDarwinGetWebProxy,
  parseDarwinProxySetting,
  parseDarwinServices,
  parseGSettingsPort,
  parseGSettingsString,
  parseSystemProxySnapshot,
  parseWindowsRegistryProxyValues,
  parseWindowsRegQuery,
} from "./sysproxy.js";

describe("sysproxy", () => {
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

    it("parses enabled proxy output from reg query", () => {
      const sample = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    ProxyOverride    REG_SZ    <local>;localhost
`;
      const parsed = parseWindowsRegQuery(sample);
      assert.equal(parsed.enabled, true);
      assert.equal(parsed.server, "127.0.0.1:7890");
    });

    it("parses disabled proxy output with decimal DWORD", () => {
      const sample = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0
    ProxyServer    REG_SZ    127.0.0.1:7890
`;
      const parsed = parseWindowsRegQuery(sample);
      assert.equal(parsed.enabled, false);
      assert.equal(parsed.server, "127.0.0.1:7890");
    });

    it("handles output where proxy keys are missing", () => {
      const sample = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    MigrateProxy    REG_DWORD    0x1
`;
      const parsed = parseWindowsRegQuery(sample);
      assert.equal(parsed.enabled, false);
      assert.equal(parsed.server, undefined);
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

      const missing = parseWindowsRegistryProxyValues(
        "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\n",
      );
      assert.deepEqual(missing, {
        proxyEnable: null,
        proxyServer: null,
        proxyOverride: null,
        autoConfigUrl: null,
        autoDetect: null,
      });
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

    it("parses enabled getwebproxy output", () => {
      const sample = `
Enabled: Yes
Server: 127.0.0.1
Port: 7890
Authenticated Proxy Enabled: 0
`;
      const parsed = parseDarwinGetWebProxy(sample);
      assert.equal(parsed.enabled, true);
      assert.equal(parsed.server, "127.0.0.1:7890");
    });

    it("parses disabled getwebproxy output", () => {
      const sample = `
Enabled: No
Server:
Port: 0
`;
      const parsed = parseDarwinGetWebProxy(sample);
      assert.equal(parsed.enabled, false);
      assert.equal(parsed.server, undefined);
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
  });

  describe("snapshot and gsettings parsers", () => {
    it("parses escaped GVariant strings and typed uint16 ports", () => {
      assert.equal(parseGSettingsString("'proxy\\\\name\\'s'\n"), "proxy\\name's");
      assert.throws(() => parseGSettingsString("manual"), /single-quoted/);
      assert.equal(parseGSettingsPort("uint16 17890\n", "test port"), 17890);
      assert.equal(parseGSettingsPort("1080", "test port"), 1080);
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
    });
  });
});
