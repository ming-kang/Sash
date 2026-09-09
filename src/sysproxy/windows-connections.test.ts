import assert from "node:assert/strict";
import { it } from "node:test";
import {
  countWindowsProxyConnections,
  inspectWindowsProxyConnections,
} from "./windows-connections.js";

const header =
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections";

it("detects additional connection records while preserving opaque Windows values", async () => {
  const output = `${header}\r\n    DefaultConnectionSettings    REG_BINARY    01000000\r\n    SavedLegacySettings    REG_BINARY    02000000\r\n`;
  assert.equal(countWindowsProxyConnections(output), 0);
  const records = `${output}    Work VPN 中文    REG_BINARY    0a001f00\r\n    Second connection    REG_BINARY    FF00\r\n`;
  assert.deepEqual(
    await inspectWindowsProxyConnections({
      platform: "win32",
      run: async (command, args) => {
        assert.equal(command, "reg.exe");
        assert.deepEqual(args, ["query", header.replace("HKEY_CURRENT_USER", "HKCU")]);
        return records;
      },
    }),
    { supported: true, additionalRecords: 2 },
  );
  assert.deepEqual(
    await inspectWindowsProxyConnections({
      platform: "linux",
      run: async () => assert.fail("unsupported hosts must not run registry tools"),
    }),
    { supported: false },
  );
});

it("preserves unknown registry observations instead of assuming no per-connection settings", async () => {
  for (const output of [
    "",
    "Access denied",
    "HKEY_CURRENT_USER\\Other",
    `${header}\n    Work VPN    REG_BINARY    secret-not-hex`,
    `${header}\n    DefaultConnectionSettings    REG_SZ    text`,
    `${header}\n    Work VPN    REG_BINARY    00\n    work vpn    REG_BINARY    00`,
  ])
    assert.throws(() => countWindowsProxyConnections(output));
  await assert.rejects(
    inspectWindowsProxyConnections({
      platform: "win32",
      run: async () => {
        throw new Error("access denied");
      },
    }),
    /access denied/,
  );
});
