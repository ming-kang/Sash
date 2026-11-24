import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it, onTestFinished } from "vitest";
import { sashLayout } from "../paths.js";
import {
  HELPER_PROTOCOL,
  type HelperOp,
  type HelperReply,
  helperAssetName,
  installScript,
  privilegeFromReply,
  quoteWindowsArgument,
  requestHelper,
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
    assert.equal(helperAssetName("arm64"), "sash-tun-helper-win32-arm64.exe");
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

describe("requestHelper", () => {
  it.skipIf(process.platform !== "win32")("exchanges one JSON line over the pipe", async () => {
    const pipe = `\\\\.\\pipe\\sash-tun-test-${process.pid}-${Date.now()}`;
    const seen: string[] = [];
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        seen.push(chunk.toString());
        socket.end(`${JSON.stringify(reply({ running: true, pid: 9 }))}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    assert.deepEqual(await requestHelper("status", 2_000, pipe), reply({ running: true, pid: 9 }));
    assert.deepEqual(seen, ['{"op":"status"}\n']);
  });

  it("fails fast when nothing listens", async () => {
    const pipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\sash-tun-missing-${process.pid}`
        : path.join(os.tmpdir(), `sash-tun-missing-${process.pid}.sock`);
    await assert.rejects(requestHelper("status", 2_000, pipe), /ENOENT|ECONNREFUSED/);
  });
});
