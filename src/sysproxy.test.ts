import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_BYPASS_LIST,
  formatWindowsBypass,
  isSystemProxySupported,
  parseDarwinGetWebProxy,
  parseDarwinServices,
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
  });
});
