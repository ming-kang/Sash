import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type { WindowsSystemProxySnapshot } from "./types.js";
import {
  applyWindowsSnapshot,
  captureWindowsSnapshot,
  createWindowsTarget,
  restoreWindowsSnapshot,
} from "./windows.js";

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
    connections: {},
    ...overrides,
  };
}

function valueName(command: RecordedCommand): string | undefined {
  const index = command.args.indexOf("/v");
  return index < 0 ? undefined : command.args[index + 1];
}

function isPowerShell(command: string): boolean {
  return /(?:^|[\\/])(?:powershell|pwsh)\.exe$/i.test(command);
}

describe("Windows system proxy backend", () => {
  it("keeps registry results and reports how to recover when neither notification host is available", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message: string) => warnings.push(message));
    const writes: string[] = [];
    await applyWindowsSnapshot(windowsSnapshot(), async (command, args) => {
      if (isPowerShell(command)) throw Object.assign(new Error("host missing"), { code: "ENOENT" });
      if (command === "reg.exe" && args[0] === "query") {
        return registryOutput("ProxyEnable    REG_DWORD    0x1");
      }
      writes.push(args.join(" "));
      return "";
    });
    assert.equal(writes.length, 4);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /Restart affected applications/);
    const failure = new Error("original registry error");
    await assert.rejects(
      applyWindowsSnapshot(windowsSnapshot(), async (command) => {
        if (isPowerShell(command)) throw new Error("host missing");
        throw failure;
      }),
      (error) => error === failure,
    );
  });
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
      {
        command: "reg.exe",
        args: ["query", `${INTERNET_SETTINGS.replace("HKEY_CURRENT_USER", "HKCU")}\\Connections`],
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
      connections: {},
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
      if (command === "reg.exe" && args[0] === "query") {
        return registryOutput("ProxyEnable    REG_DWORD    0x1");
      }
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
    assert.ok(calls.some((call) => isPowerShell(call.command)));
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
    assert.ok(calls.some((call) => isPowerShell(call.command)));
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

describe("Windows system proxy journal restore", () => {
  const HKCU_SETTINGS = INTERNET_SETTINGS.replace("HKEY_CURRENT_USER", "HKCU");
  const HKCU_CONNECTIONS = `${HKCU_SETTINGS}\\Connections`;

  interface RegistryFixture {
    calls: RecordedCommand[];
    run: (command: string, args: string[]) => Promise<string>;
    flat: Map<string, string>;
    connections: Map<string, string>;
  }
  function registryFixture(
    flat: Map<string, string>,
    connections: Map<string, string>,
  ): RegistryFixture {
    const calls: RecordedCommand[] = [];
    const run = async (command: string, args: string[]): Promise<string> => {
      calls.push({ command, args: [...args] });
      if (isPowerShell(command)) throw new Error("no shell host");
      if (command !== "reg.exe") return "";
      if (args[0] === "query" && args[1] === HKCU_SETTINGS) {
        return registryOutput(...[...flat].map(([name, line]) => `${name}    ${line}`));
      }
      if (args[0] === "query" && args[1] === HKCU_CONNECTIONS) {
        return [
          HKCU_CONNECTIONS,
          ...[...connections].map(([n, h]) => `    ${n}    REG_BINARY    ${h}`),
        ].join("\r\n");
      }
      if (args[0] === "add" && args[1] === HKCU_SETTINGS) {
        flat.set(
          String(args[args.indexOf("/v") + 1]),
          `${args[args.indexOf("/t") + 1]}    ${args[args.indexOf("/d") + 1]}`,
        );
        return "";
      }
      if (args[0] === "add" && args[1] === HKCU_CONNECTIONS) {
        connections.set(
          String(args[args.indexOf("/v") + 1]),
          String(args[args.indexOf("/d") + 1]).toUpperCase(),
        );
        return "";
      }
      if (args[0] === "delete") {
        flat.delete(String(args[args.indexOf("/v") + 1]));
        return "";
      }
      return "";
    };
    return { calls, run, flat, connections };
  }

  const original = windowsSnapshot({
    proxyEnable: 0,
    proxyServer: null,
    proxyOverride: "localhost",
    autoConfigUrl: null,
    connections: { DefaultConnectionSettings: "AA00", Vpn: "BB11" },
  });
  const target = windowsSnapshot({
    proxyEnable: 1,
    proxyServer: "127.0.0.1:7890",
    proxyOverride: "localhost;<local>",
    autoConfigUrl: null,
    connections: {},
  });
  const targetFlat = () =>
    new Map([
      ["ProxyEnable", "REG_DWORD    0x1"],
      ["ProxyServer", "REG_SZ    127.0.0.1:7890"],
      ["ProxyOverride", "REG_SZ    localhost;<local>"],
    ]);

  it("restores flat values still equal to the target state", async () => {
    const fixture = registryFixture(targetFlat(), new Map());
    const result = await restoreWindowsSnapshot(
      windowsSnapshot({ ...original, connections: {} }),
      target,
      fixture.run,
    );
    assert.deepEqual(result.skipped, []);
    assert.equal(fixture.flat.get("ProxyEnable"), "REG_DWORD    0");
    assert.equal(fixture.flat.get("ProxyServer"), undefined);
    assert.equal(fixture.flat.get("ProxyOverride"), "REG_SZ    localhost");
  });

  it("leaves a blob equal to the journal untouched without skipping it", async () => {
    const fixture = registryFixture(
      targetFlat(),
      new Map([
        ["DefaultConnectionSettings", "AA00"],
        ["Vpn", "BB11"],
      ]),
    );
    const result = await restoreWindowsSnapshot(original, target, fixture.run);
    assert.deepEqual(result.skipped, []);
  });

  it("restores a blob equal to the target blob", async () => {
    const targetWithBlobs = windowsSnapshot({
      ...target,
      connections: { DefaultConnectionSettings: "DD44" },
    });
    const fixture = registryFixture(
      targetFlat(),
      new Map([
        ["DefaultConnectionSettings", "DD44"],
        ["Vpn", "BB11"],
      ]),
    );
    const result = await restoreWindowsSnapshot(original, targetWithBlobs, fixture.run);
    assert.deepEqual(result.skipped, []);
    assert.equal(fixture.connections.get("DefaultConnectionSettings"), "AA00");
  });

  it("skips and reports a flat field modified outside Sash", async () => {
    const flat = targetFlat();
    flat.set("ProxyServer", "REG_SZ    foreign.example:3128");
    const fixture = registryFixture(flat, new Map());
    const result = await restoreWindowsSnapshot(
      windowsSnapshot({ ...original, connections: {} }),
      target,
      fixture.run,
    );
    assert.equal(fixture.flat.get("ProxyServer"), "REG_SZ    foreign.example:3128");
    assert.deepEqual(result.skipped, [
      { key: "proxyServer", service: "Internet Settings", reason: "modified" },
    ]);
  });

  it("leaves named connection blobs outside Sash ownership out of restore decisions", async () => {
    const fixture = registryFixture(targetFlat(), new Map([["Vpn", "CC22"]]));
    const result = await restoreWindowsSnapshot(
      windowsSnapshot({ ...original, connections: { Vpn: "BB11" } }),
      target,
      fixture.run,
    );
    assert.equal(fixture.connections.get("Vpn"), "CC22");
    assert.deepEqual(result.skipped, []);
  });

  // Realistic WinINet blob: u32 version, u32 counter, u32 flags, then three
  // u32-length-prefixed ASCII strings (proxyServer/proxyBypass/autoConfigURL).
  const blob = (counter: number, flags: number, server = "", bypass = "", cfg = ""): string => {
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46, 0);
    header.writeUInt32LE(counter, 4);
    header.writeUInt32LE(flags, 8);
    const parts: Buffer[] = [header];
    for (const s of [server, bypass, cfg]) {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(Buffer.byteLength(s, "latin1"), 0);
      parts.push(len, Buffer.from(s, "latin1"));
    }
    return Buffer.concat(parts).toString("hex").toUpperCase();
  };

  it("ignores a WinINet counter bump on an otherwise identical blob", async () => {
    // proxy on → refresh bumps the counter without touching user fields —
    // the plain on → off cycle must NOT be reported as external modification.
    const originalBlob = blob(0x2c, 0x09);
    const bumped = blob(0x2e, 0x09);
    const fixture = registryFixture(targetFlat(), new Map([["DefaultConnectionSettings", bumped]]));
    const result = await restoreWindowsSnapshot(
      windowsSnapshot({ ...original, connections: { DefaultConnectionSettings: originalBlob } }),
      windowsSnapshot({
        ...target,
        connections: { DefaultConnectionSettings: originalBlob },
      }),
      fixture.run,
    );
    assert.deepEqual(result.skipped, []);
  });

  it("ignores DIRECT-bit drift on an otherwise identical blob", async () => {
    const originalBlob = blob(0x2c, 0x09);
    const drifted = blob(0x2e, 0x08);
    const fixture = registryFixture(
      targetFlat(),
      new Map([["DefaultConnectionSettings", drifted]]),
    );
    const result = await restoreWindowsSnapshot(
      windowsSnapshot({ ...original, connections: { DefaultConnectionSettings: originalBlob } }),
      windowsSnapshot({
        ...target,
        connections: { DefaultConnectionSettings: originalBlob },
      }),
      fixture.run,
    );
    assert.deepEqual(result.skipped, []);
  });

  it("restores a blob matching the target semantically despite counter drift", async () => {
    const originalBlob = blob(0x2c, 0x09);
    const targetBlob = blob(0x2e, 0x02, "127.0.0.1:7890", "localhost");
    const drifted = blob(0x30, 0x02, "127.0.0.1:7890", "localhost");
    const fixture = registryFixture(
      targetFlat(),
      new Map([["DefaultConnectionSettings", drifted]]),
    );
    const result = await restoreWindowsSnapshot(
      windowsSnapshot({ ...original, connections: { DefaultConnectionSettings: originalBlob } }),
      windowsSnapshot({
        ...target,
        connections: { DefaultConnectionSettings: targetBlob },
      }),
      fixture.run,
    );
    assert.deepEqual(result.skipped, []);
    assert.equal(fixture.connections.get("DefaultConnectionSettings"), originalBlob);
  });

  it("restores an applied LAN blob that retains inactive PAC text", async () => {
    const pac = "http://127.0.0.1:9/pac-test.pac";
    const originalBlob = blob(0x7e, 0x09, "127.0.0.1:7890", "localhost", pac);
    const targetBlob = blob(0x7f, 0x0b, "127.0.0.1:7890", "localhost;<local>", pac);
    const applied = blob(0x80, 0x0b, "127.0.0.1:7890", "localhost;<local>", pac);
    const fixture = registryFixture(
      targetFlat(),
      new Map([["DefaultConnectionSettings", applied]]),
    );
    const result = await restoreWindowsSnapshot(
      windowsSnapshot({ ...original, connections: { DefaultConnectionSettings: originalBlob } }),
      windowsSnapshot({
        ...target,
        connections: { DefaultConnectionSettings: targetBlob },
      }),
      fixture.run,
    );
    assert.deepEqual(result.skipped, []);
    assert.equal(fixture.connections.get("DefaultConnectionSettings"), originalBlob);
  });

  it("restores a LAN blob holding a per-field transition between original and target", async () => {
    const pac = "http://127.0.0.1:9/pac-test.pac";
    const originalBlob = blob(0x7e, 0x09, "127.0.0.1:7890", "localhost", pac);
    const targetBlob = blob(0x7f, 0x0b, "127.0.0.1:7890", "localhost;<local>", pac);
    const transitional = blob(0x80, 0x09, "127.0.0.1:7890", "localhost;<local>", pac);
    const fixture = registryFixture(
      targetFlat(),
      new Map([["DefaultConnectionSettings", transitional]]),
    );
    const result = await restoreWindowsSnapshot(
      windowsSnapshot({ ...original, connections: { DefaultConnectionSettings: originalBlob } }),
      windowsSnapshot({
        ...target,
        connections: { DefaultConnectionSettings: targetBlob },
      }),
      fixture.run,
    );
    assert.deepEqual(result.skipped, []);
    assert.equal(fixture.connections.get("DefaultConnectionSettings"), originalBlob);
  });

  it("still skips a LAN blob when one field is neither original nor target", async () => {
    const pac = "http://127.0.0.1:9/pac-test.pac";
    const originalBlob = blob(0x7e, 0x09, "127.0.0.1:7890", "localhost", pac);
    const targetBlob = blob(0x7f, 0x0b, "127.0.0.1:7890", "localhost;<local>", pac);
    const foreign = blob(0x80, 0x09, "127.0.0.1:7890", "foreign-bypass", pac);
    const fixture = registryFixture(
      targetFlat(),
      new Map([["DefaultConnectionSettings", foreign]]),
    );
    const result = await restoreWindowsSnapshot(
      windowsSnapshot({ ...original, connections: { DefaultConnectionSettings: originalBlob } }),
      windowsSnapshot({
        ...target,
        connections: { DefaultConnectionSettings: targetBlob },
      }),
      fixture.run,
    );
    assert.deepEqual(result.skipped, [
      {
        key: "DefaultConnectionSettings",
        service: "Connections\\DefaultConnectionSettings",
        reason: "modified",
      },
    ]);
    assert.equal(fixture.connections.get("DefaultConnectionSettings"), foreign);
  });

  it("still reports semantic changes hidden behind equal lengths", async () => {
    const originalBlob = blob(0x2c, 0x09);
    const foreign = blob(0x2e, 0x02, "foreign.example:3128");
    const fixture = registryFixture(
      targetFlat(),
      new Map([["DefaultConnectionSettings", foreign]]),
    );
    const result = await restoreWindowsSnapshot(
      windowsSnapshot({ ...original, connections: { DefaultConnectionSettings: originalBlob } }),
      windowsSnapshot({
        ...target,
        connections: { DefaultConnectionSettings: originalBlob },
      }),
      fixture.run,
    );
    assert.deepEqual(result.skipped, [
      {
        key: "DefaultConnectionSettings",
        service: "Connections\\DefaultConnectionSettings",
        reason: "modified",
      },
    ]);
  });

  it("does not treat a missing named connection entry as a LAN restore failure", async () => {
    const fixture = registryFixture(targetFlat(), new Map());
    const result = await restoreWindowsSnapshot(
      windowsSnapshot({ ...original, connections: { Vpn: "BB11" } }),
      target,
      fixture.run,
    );
    assert.equal(fixture.connections.has("Vpn"), false);
    assert.deepEqual(result.skipped, []);
  });

  it("reports a blob the refresh rewrote after the write", async () => {
    const targetWithBlobs = windowsSnapshot({
      ...target,
      connections: { DefaultConnectionSettings: "DD44" },
    });
    const fixture = registryFixture(targetFlat(), new Map([["DefaultConnectionSettings", "DD44"]]));
    let rewritten = false;
    const run = async (command: string, args: string[]): Promise<string> => {
      const out = await fixture.run(command, args);
      // WinINet rewrites the blob during the post-write refresh.
      if (
        command === "reg.exe" &&
        args[0] === "add" &&
        args[1] === HKCU_CONNECTIONS &&
        !rewritten
      ) {
        rewritten = true;
        fixture.connections.set("DefaultConnectionSettings", "FFEE");
      }
      return out;
    };
    const result = await restoreWindowsSnapshot(
      windowsSnapshot({ ...original, connections: { DefaultConnectionSettings: "AA00" } }),
      targetWithBlobs,
      run,
    );
    assert.deepEqual(result.skipped, [
      {
        key: "DefaultConnectionSettings",
        service: "Connections\\DefaultConnectionSettings",
        reason: "modified",
      },
    ]);
  });
});

it("apply never writes per-connection blobs — named or LAN", async () => {
  const writes: string[] = [];
  const snapshot = windowsSnapshot({
    connections: {
      DefaultConnectionSettings: "AA00BB11",
      SavedLegacySettings: "CC22DD33",
      "Office VPN": "EE44FF55",
    },
  });
  await assert.rejects(
    applyWindowsSnapshot(snapshot, async (command, args) => {
      if (!isPowerShell(command) && args[0] !== "query") writes.push(args.join(" "));
      return "";
    }),
    /could not verify|registry output/,
  );
  assert.equal(writes.length, 4, "apply writes only the flat keys");
  assert.equal(
    writes.filter((w) => w.includes("Connections")).length,
    0,
    "no reg add may target the Connections key",
  );
});

describe("Windows apply LAN-blob verification", () => {
  const HKCU_SETTINGS = INTERNET_SETTINGS.replace("HKEY_CURRENT_USER", "HKCU");
  const HKCU_CONNECTIONS = `${HKCU_SETTINGS}\\Connections`;

  function lanBlobHex(flags: number, server: string, bypass: string, pac = ""): string {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(0x46, 0);
    const flagBytes = Buffer.alloc(4);
    flagBytes.writeUInt32LE(flags, 0);
    const fields = [server, bypass, pac].map((text) => {
      const body = Buffer.from(text, "latin1");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(body.length, 0);
      return Buffer.concat([len, body]);
    });
    return Buffer.concat([head, flagBytes, ...fields])
      .toString("hex")
      .toUpperCase();
  }

  interface ApplyFixture {
    calls: RecordedCommand[];
    queries: number;
    run: (command: string, args: string[]) => Promise<string>;
    setQueryResult(value: object | null): void;
  }
  function applyFixture(
    flat: Map<string, string>,
    connections: Map<string, string>,
    queryResult: object | null,
  ): ApplyFixture {
    const calls: RecordedCommand[] = [];
    const fixture: ApplyFixture = {
      calls,
      queries: 0,
      setQueryResult: (value) => {
        queryResult = value;
      },
      run: async (command: string, args: string[]) => {
        calls.push({ command, args: [...args] });
        if (isPowerShell(command)) {
          const script = args.join(" ");
          if (script.includes("InternetQueryOption")) {
            fixture.queries += 1;
            if (queryResult === null) throw new Error("query failed");
            return JSON.stringify(queryResult);
          }
          return ""; // InternetSetOption refresh
        }
        if (command !== "reg.exe") return "";
        if (args[0] === "query" && args[1] === HKCU_SETTINGS) {
          return registryOutput(...[...flat].map(([name, line]) => `${name}    ${line}`));
        }
        if (args[0] === "query" && args[1] === HKCU_CONNECTIONS) {
          return [
            HKCU_CONNECTIONS,
            ...[...connections].map(([n, h]) => `    ${n}    REG_BINARY    ${h}`),
          ].join("\r\n");
        }
        return "";
      },
    };
    return fixture;
  }

  const appliedFlat = () =>
    new Map([
      ["ProxyEnable", "REG_DWORD    0x1"],
      ["ProxyServer", "REG_SZ    127.0.0.1:7890"],
      ["ProxyOverride", "REG_SZ    localhost;<local>"],
    ]);
  const effective = {
    flags: 0x0b,
    proxyServer: "127.0.0.1:7890",
    proxyBypass: "localhost;<local>",
    autoConfigUrl: "",
  };
  const expectedBlob = lanBlobHex(0x0b, "127.0.0.1:7890", "localhost;<local>");

  it("proves a missing LAN blob through InternetQueryOption instead of reporting success", async () => {
    const target = windowsSnapshot({
      proxyEnable: 1,
      proxyServer: "127.0.0.1:7890",
      proxyOverride: "localhost;<local>",
      autoConfigUrl: null,
      connections: { DefaultConnectionSettings: expectedBlob },
    });
    const fixture = applyFixture(appliedFlat(), new Map(), effective);
    await applyWindowsSnapshot(target, fixture.run);
    // Registry never materialized the blob: proven via the API, so the
    // expectation is dropped from the target rather than adopted.
    assert.equal(target.connections.DefaultConnectionSettings, undefined);
    assert.equal(fixture.queries, 1);
  });

  it("proves an unparseable LAN blob through InternetQueryOption and records the readback bytes", async () => {
    const target = windowsSnapshot({
      proxyEnable: 1,
      proxyServer: "127.0.0.1:7890",
      proxyOverride: "localhost;<local>",
      autoConfigUrl: null,
      connections: { DefaultConnectionSettings: expectedBlob },
    });
    const fixture = applyFixture(
      appliedFlat(),
      new Map([["DefaultConnectionSettings", "AA00"]]),
      effective,
    );
    await applyWindowsSnapshot(target, fixture.run);
    assert.equal(target.connections.DefaultConnectionSettings, "AA00");
    assert.equal(fixture.queries, 1);
  });

  it("preserves and accepts inactive PAC text retained by WinINet", async () => {
    const pac = "http://127.0.0.1:9/pac-test.pac";
    const originalBlob = lanBlobHex(0x09, "127.0.0.1:7890", "localhost", pac);
    const original = windowsSnapshot({
      proxyEnable: 0,
      proxyServer: "127.0.0.1:7890",
      proxyOverride: "localhost",
      autoConfigUrl: null,
      connections: {
        SavedLegacySettings: originalBlob,
        DefaultConnectionSettings: originalBlob,
      },
    });
    const target = createWindowsTarget({ port: 7890, bypass: ["localhost", "<local>"] }, original);
    const retained = lanBlobHex(0x0b, "127.0.0.1:7890", "localhost;<local>", pac);
    assert.equal(target.connections.SavedLegacySettings, retained);
    assert.equal(target.connections.DefaultConnectionSettings, retained);
    const fixture = applyFixture(
      appliedFlat(),
      new Map([
        ["SavedLegacySettings", retained],
        ["DefaultConnectionSettings", retained],
      ]),
      effective,
    );
    await applyWindowsSnapshot(target, fixture.run);
    assert.equal(target.connections.SavedLegacySettings, retained);
    assert.equal(target.connections.DefaultConnectionSettings, retained);
    assert.equal(fixture.queries, 0);
  });

  it("fails the apply when the registry blob is parseable but conflicting, even if the API matches", async () => {
    const conflicting = lanBlobHex(0x0f, "foreign.example:3128", "other-bypass", "http://x/p");
    const target = windowsSnapshot({
      proxyEnable: 1,
      proxyServer: "127.0.0.1:7890",
      proxyOverride: "localhost;<local>",
      autoConfigUrl: null,
      connections: { DefaultConnectionSettings: expectedBlob },
    });
    const fixture = applyFixture(
      appliedFlat(),
      new Map([["DefaultConnectionSettings", conflicting]]),
      effective,
    );
    await assert.rejects(applyWindowsSnapshot(target, fixture.run), /could not verify/);
    // The effective-settings API only stands in for a missing or
    // unparseable blob — it is never consulted over a proven conflict.
    assert.equal(fixture.queries, 0);
    assert.equal(target.connections.DefaultConnectionSettings, expectedBlob);
  });

  it("fails the apply when neither the registry nor the API can prove the settings", async () => {
    const target = windowsSnapshot({
      proxyEnable: 1,
      proxyServer: "127.0.0.1:7890",
      proxyOverride: "localhost;<local>",
      autoConfigUrl: null,
      connections: { DefaultConnectionSettings: expectedBlob },
    });
    const fixture = applyFixture(appliedFlat(), new Map(), {
      flags: 0x0b,
      proxyServer: "foreign.example:3128",
      proxyBypass: "localhost;<local>",
      autoConfigUrl: "",
    });
    await assert.rejects(applyWindowsSnapshot(target, fixture.run), /could not verify/);
    assert.equal(fixture.queries, 1);
  });
});
