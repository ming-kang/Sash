import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, onTestFinished } from "vitest";
import { grantScript, inspectSetuidCore, revokeScript } from "./macos.js";

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
