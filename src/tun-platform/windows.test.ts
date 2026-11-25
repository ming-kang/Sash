import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { sashLayout } from "../paths.js";
import { HELPER_PROTOCOL, type HelperOp, type HelperReply } from "./helper-pipe.js";
import type { HelperSource } from "./helper-source.js";
import {
  installScript,
  privilegeFromReply,
  quoteWindowsArgument,
  serviceArguments,
  uninstallScript,
  windowsTunPlatform,
} from "./windows.js";

const layout = sashLayout("C:\\Users\\Dev User\\AppData\\Local\\Sash");

function reply(patch: Partial<HelperReply> = {}): HelperReply {
  return { ok: true, protocol: HELPER_PROTOCOL, home: layout.root, running: false, ...patch };
}

describe("Windows helper arguments", () => {
  it("quotes like CommandLineToArgvW expects", () => {
    assert.equal(quoteWindowsArgument("service"), "service");
    assert.equal(quoteWindowsArgument("C:\\Program Files\\x"), '"C:\\Program Files\\x"');
    assert.equal(quoteWindowsArgument("C:\\a b\\"), '"C:\\a b\\\\"');
    assert.equal(quoteWindowsArgument('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteWindowsArgument(""), '""');
  });

  it("fixes the Core, data folder, logs and account at installation", () => {
    assert.equal(
      serviceArguments(layout, "S-1-5-21-1-2-3-1001"),
      [
        "service --user S-1-5-21-1-2-3-1001",
        `--core "${layout.coreExe}"`,
        `--home "${layout.root}"`,
        `--config "${layout.configFile}"`,
        `--stdout "${layout.coreLogFile}"`,
        `--stderr "${layout.coreErrLogFile}"`,
      ].join(" "),
    );
  });
});

describe("Windows elevated scripts", () => {
  it("verify the copied helper inside the protected directory before registering it", () => {
    const script = installScript({
      source: "C:\\Users\\o'neil\\AppData\\Local\\Sash\\temp\\sash-tun-helper-win32-x64.exe",
      sha256: "a".repeat(64),
      arguments: "service --user S-1-5-21-1",
    });
    assert.match(script, /'C:\\Users\\o''neil\\AppData/);
    const protect = script.indexOf("Protect-Directory $dir }");
    const copy = script.indexOf("Copy-Item");
    const hash = script.indexOf("Get-FileHash -LiteralPath $helperExe");
    const register = script.indexOf("New-Service");
    assert.ok(protect > 0 && protect < copy && copy < hash && hash < register);
    assert.match(script, /icacls\.exe \$dir \/setowner '\*S-1-5-32-544'/);
    assert.match(script, /-StartupType Automatic/);
  });

  it("replace the 0.7.0 helper service on install and uninstall", () => {
    for (const script of [
      installScript({ source: "s", sha256: "b", arguments: "a" }),
      uninstallScript(),
    ]) {
      assert.match(script, /Remove-SashService 'SashTun'/);
      assert.match(script, /Remove-SashService 'SashTunHelper'/);
      assert.match(script, /\$legacyDir = Join-Path \$sashDir 'core'/);
    }
  });
});

describe("Windows helper state", () => {
  it("is ready only for this data folder and protocol", () => {
    assert.deepEqual(privilegeFromReply(reply(), layout), { state: "ready" });
    assert.deepEqual(privilegeFromReply(reply({ home: layout.root.toUpperCase() }), layout), {
      state: "ready",
    });
    assert.equal(privilegeFromReply(reply({ home: "D:\\Other" }), layout).state, "stale");
    assert.equal(
      privilegeFromReply(reply({ protocol: HELPER_PROTOCOL + 1 }), layout).state,
      "stale",
    );
  });

  it("tells a missing service from a stopped or legacy one", async () => {
    const unreachable = async (): Promise<HelperReply> => {
      throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
    };
    const inspect = (registered: string[]) =>
      windowsTunPlatform({
        request: unreachable,
        serviceRegistered: async (name) => registered.includes(name),
      }).inspect(layout);
    assert.deepEqual(await inspect([]), { state: "missing" });
    assert.equal((await inspect(["SashTun"])).state, "stale");
    assert.match((await inspect(["SashTunHelper"])).detail ?? "", /0\.7\.0/);
  });

  it("hosts a Core only for its own data folder", async () => {
    const calls: HelperOp[] = [];
    let home = layout.root;
    const host = windowsTunPlatform({
      request: async (op) => {
        calls.push(op);
        return reply({ home, running: op === "start", ...(op === "start" ? { pid: 77 } : {}) });
      },
    }).host?.(layout);
    assert.ok(host);
    assert.deepEqual(await host.start(), { pid: 77 });
    assert.deepEqual(calls, ["status", "start"]);
    home = "D:\\Other";
    await assert.rejects(host.start(), /cannot start this Core/);
    assert.deepEqual(calls, ["status", "start", "status"]);
  });
});

describe("windowsTunPlatform install", () => {
  function fakeSource(cleanup: () => void): HelperSource {
    return {
      file: "C:\\Users\\Dev User\\AppData\\Local\\Sash\\temp\\sash-tun-helper-win32-x64.exe",
      sha256: "a".repeat(64),
      cleanup: async () => cleanup(),
    };
  }

  it("runs the script built from the source and service arguments, then cleans up", async () => {
    let cleaned = false;
    const source = fakeSource(() => {
      cleaned = true;
    });
    const runs: { script: string; action: string }[] = [];
    const platform = windowsTunPlatform({
      resolveSource: async () => source,
      userSid: async () => "S-1-5-21-1-2-3-1001",
      run: async (script, action) => {
        runs.push({ script, action });
      },
      request: async () => reply(),
    });
    await platform.install(layout);
    assert.deepEqual(
      runs.map((run) => run.action),
      ["install the TUN helper"],
    );
    assert.equal(
      runs[0]?.script,
      installScript({
        source: source.file,
        sha256: source.sha256,
        arguments: serviceArguments(layout, "S-1-5-21-1-2-3-1001"),
      }),
    );
    assert.equal(cleaned, true);
  });

  it("cleans the source up when the elevated run fails", async () => {
    let cleaned = false;
    const platform = windowsTunPlatform({
      resolveSource: async () =>
        fakeSource(() => {
          cleaned = true;
        }),
      userSid: async () => "S-1-5-21-1-2-3-1001",
      run: async () => {
        throw new Error("Windows administrator approval was cancelled");
      },
      request: async () => {
        throw new Error("inspection must not be polled after a failed run");
      },
    });
    await assert.rejects(platform.install(layout), /approval was cancelled/);
    assert.equal(cleaned, true);
  });

  it("polls inspection until the service is ready", async () => {
    let statuses = 0;
    const platform = windowsTunPlatform({
      resolveSource: async () => fakeSource(() => {}),
      userSid: async () => "S-1-5-21-1-2-3-1001",
      run: async () => {},
      request: async () => {
        statuses += 1;
        return reply({ home: statuses < 2 ? "D:\\Other" : layout.root });
      },
    });
    await platform.install(layout);
    assert.equal(statuses, 2);
  });

  it("removes the helper through the injected runner on uninstall", async () => {
    const runs: { script: string; action: string }[] = [];
    const platform = windowsTunPlatform({
      run: async (script, action) => {
        runs.push({ script, action });
      },
    });
    await platform.uninstall(layout);
    assert.deepEqual(runs, [{ script: uninstallScript(), action: "remove the TUN helper" }]);
  });
});
