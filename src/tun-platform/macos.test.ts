import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, onTestFinished } from "vitest";
import { sashLayout } from "../paths.js";
import { grantScript, inspectSetuidCore, macosTunPlatform, revokeScript } from "./macos.js";

describe("macOS scripts", () => {
  it("make the Core setuid root for the user's group, quoting every path", () => {
    const script = grantScript(
      "/Users/o'neil/Library/Application Support/Sash/bin/mihomo",
      "o'neil",
    );
    assert.match(
      script,
      /core='\/Users\/o'\\''neil\/Library\/Application Support\/Sash\/bin\/mihomo'/,
    );
    assert.match(script, /user='o'\\''neil'/);
    assert.match(script, /\/usr\/sbin\/chown "root:\$group" "\$core"/);
    assert.match(script, /\/bin\/chmod 4750 "\$core"/);
    assert.match(script, /\[ -L "\$core" \]/);
  });

  it("return the Core and the root-created data to the user on revoke", () => {
    const script = revokeScript("/data/bin/mihomo", "/data", "dev");
    assert.match(script, /\/usr\/sbin\/chown "\$user:\$group" "\$core"/);
    assert.match(script, /\/bin\/chmod 0755 "\$core"/);
    assert.match(script, /\/usr\/sbin\/chown -R -h "\$user:\$group" "\$home"/);
  });

  it("retire the 0.7.0 LaunchDaemon helper", () => {
    for (const script of [grantScript("/c", "u"), revokeScript("/c", "/h", "u")]) {
      assert.match(script, /launchctl bootout "system\/\$legacy"/);
      assert.match(script, /dev\.astralyn\.sash\.helper/);
    }
  });
});

describe("macosTunPlatform elevation", () => {
  function layoutWithCore(core = true) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-macos-tun-layout-"));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const layout = sashLayout(root);
    if (core) {
      fs.mkdirSync(path.dirname(layout.coreExe), { recursive: true });
      fs.writeFileSync(layout.coreExe, "core");
    }
    return layout;
  }

  function recordingRunner() {
    const runs: { script: string; action: string }[] = [];
    return {
      runs,
      run: async (script: string, action: string) => {
        runs.push({ script, action });
      },
    };
  }

  it("refuses to install before the Core is installed", async () => {
    const { runs, run } = recordingRunner();
    const platform = macosTunPlatform({ run });
    await assert.rejects(platform.install(layoutWithCore(false)), /Core is not installed/);
    assert.equal(runs.length, 0);
  });

  it("passes the grant script for the Core and user to the elevated runner", async () => {
    const { runs, run } = recordingRunner();
    const layout = layoutWithCore();
    await macosTunPlatform({ run }).install(layout);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.script, grantScript(layout.coreExe, os.userInfo().username));
    assert.equal(runs[0]?.action, "authorize its Core for TUN Mode");
  });

  it("passes the revoke script to the elevated runner on uninstall", async () => {
    const { runs, run } = recordingRunner();
    const layout = layoutWithCore();
    await macosTunPlatform({ run }).uninstall(layout);
    assert.deepEqual(runs, [
      {
        script: revokeScript(layout.coreExe, layout.root, os.userInfo().username),
        action: "remove the TUN Mode authorization from its Core",
      },
    ]);
  });
});

describe("inspectSetuidCore", () => {
  // Windows reports uid 0 for every file, so ownership checks only mean something on POSIX.
  it.skipIf(process.platform === "win32")(
    "reports a missing Core and an ordinary user-owned Core as not installed",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-macos-tun-"));
      onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
      const core = path.join(dir, "mihomo");
      assert.deepEqual(await inspectSetuidCore(core), {
        state: "missing",
        detail: "Core is not installed",
      });
      fs.writeFileSync(core, "core", { mode: 0o755 });
      const expected = process.getuid?.() === 0 ? "stale" : "missing";
      assert.equal((await inspectSetuidCore(core)).state, expected);
    },
  );
});
