import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WindowsSystemProxySnapshot } from "./sysproxy/types.js";
import { applyWindowsSnapshot, captureWindowsSnapshot } from "./sysproxy/windows.js";

interface RecordedCommand {
  command: string;
  args: string[];
}

const INTERNET_SETTINGS =
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function registryOutput(...values: string[]): string {
  return [INTERNET_SETTINGS, ...values.map((value) => `    ${value}`)].join("\r\n");
}

function windowsSnapshot(
  overrides: Partial<WindowsSystemProxySnapshot> = {},
): WindowsSystemProxySnapshot {
  return {
    version: 1,
    platform: "win32",
    proxyEnable: 1,
    proxyServer: "127.0.0.1:7890",
    proxyOverride: "localhost;<local>",
    autoConfigUrl: "http://proxy.example/config.pac",
    autoDetect: 1,
    ...overrides,
  };
}

function valueName(command: RecordedCommand): string | undefined {
  const index = command.args.indexOf("/v");
  return index < 0 ? undefined : command.args[index + 1];
}

function isPowerShell(command: string): boolean {
  return /(?:^|[\\/])powershell\.exe$/i.test(command);
}

describe("Windows system proxy backend", () => {
  it("captures the managed registry values through the injected runner", async () => {
    const calls: RecordedCommand[] = [];
    const snapshot = await captureWindowsSnapshot(async (command, args) => {
      calls.push({ command, args: [...args] });
      return registryOutput(
        "ProxyEnable    REG_DWORD    0x1",
        "ProxyServer    REG_SZ    proxy.example:8080",
        "ProxyOverride    REG_SZ    localhost;<local>",
        "AutoConfigURL    REG_SZ    http://proxy.example/config.pac",
        "AutoDetect    REG_DWORD    0x0",
      );
    });

    assert.deepEqual(calls, [
      {
        command: "reg.exe",
        args: ["query", INTERNET_SETTINGS.replace("HKEY_CURRENT_USER", "HKCU")],
      },
    ]);
    assert.deepEqual(snapshot, {
      version: 1,
      platform: "win32",
      proxyEnable: 1,
      proxyServer: "proxy.example:8080",
      proxyOverride: "localhost;<local>",
      autoConfigUrl: "http://proxy.example/config.pac",
      autoDetect: 0,
    });
  });

  it("writes PAC and endpoints before ProxyEnable without managing AutoDetect", async () => {
    const calls: RecordedCommand[] = [];
    let commandActive = false;
    await applyWindowsSnapshot(windowsSnapshot(), async (command, args) => {
      assert.equal(commandActive, false, "system commands must remain sequential");
      commandActive = true;
      calls.push({ command, args: [...args] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      commandActive = false;
      return "";
    });

    assert.deepEqual(calls.slice(0, 4).map(valueName), [
      "AutoConfigURL",
      "ProxyServer",
      "ProxyOverride",
      "ProxyEnable",
    ]);
    assert.equal(
      calls.some((call) => valueName(call) === "AutoDetect"),
      false,
    );
    assert.ok(isPowerShell(calls.at(-1)?.command ?? ""));
  });

  it("accepts a failed delete only after a fresh snapshot proves absence", async () => {
    const calls: RecordedCommand[] = [];
    const deleteFailure = new Error("delete denied");
    await applyWindowsSnapshot(windowsSnapshot({ autoConfigUrl: null }), async (command, args) => {
      calls.push({ command, args: [...args] });
      if (command === "reg.exe" && args[0] === "delete") {
        throw deleteFailure;
      }
      if (command === "reg.exe" && args[0] === "query") {
        return registryOutput("ProxyEnable    REG_DWORD    0x1");
      }
      return "";
    });

    assert.deepEqual(
      calls.slice(0, 2).map((call) => [call.args[0], valueName(call)]),
      [
        ["delete", "AutoConfigURL"],
        ["query", undefined],
      ],
    );
    assert.deepEqual(calls.filter((call) => call.args[0] === "add").map(valueName), [
      "ProxyServer",
      "ProxyOverride",
      "ProxyEnable",
    ]);
    assert.ok(isPowerShell(calls.at(-1)?.command ?? ""));
  });

  it("preserves a registry failure and still awaits WinINet refresh", async () => {
    const writeFailure = new Error("registry write failed");
    let signalRefreshEntered: (() => void) | undefined;
    const refreshEntered = new Promise<void>((resolve) => {
      signalRefreshEntered = resolve;
    });
    let releaseRefresh: (() => void) | undefined;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let settled = false;
    let observedError: unknown;

    const completion = applyWindowsSnapshot(windowsSnapshot(), async (command) => {
      if (command === "reg.exe") throw writeFailure;
      signalRefreshEntered?.();
      await refreshBlocked;
      return "";
    }).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        observedError = error;
      },
    );

    await refreshEntered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    releaseRefresh?.();
    await completion;
    assert.equal(observedError, writeFailure);
  });

  it("rejects a failed delete when the fresh snapshot still contains the value", async () => {
    const deleteFailure = new Error("delete denied");
    const calls: RecordedCommand[] = [];

    await assert.rejects(
      applyWindowsSnapshot(windowsSnapshot({ autoConfigUrl: null }), async (command, args) => {
        calls.push({ command, args: [...args] });
        if (command === "reg.exe" && args[0] === "delete") throw deleteFailure;
        if (command === "reg.exe" && args[0] === "query") {
          return registryOutput(
            "ProxyEnable    REG_DWORD    0x1",
            "AutoConfigURL    REG_SZ    http://still-present.example/config.pac",
          );
        }
        return "";
      }),
      (error: unknown) => error === deleteFailure,
    );

    assert.equal(
      calls.some((call) => call.args[0] === "add"),
      false,
    );
    assert.ok(isPowerShell(calls.at(-1)?.command ?? ""));
  });
});
