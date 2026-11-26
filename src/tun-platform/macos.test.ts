import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, onTestFinished } from "vitest";
import { sashLayout } from "../paths.js";
import {
  grantScript,
  inspectSetuidCore,
  MACOS_PF_ANCHOR_LINE,
  MACOS_TUN_GUARD_SCRIPT,
  macosTunPlatform,
  PF_CONF_EDIT_FUNCTIONS,
  revokeScript,
} from "./macos.js";
import { shellQuote } from "./shared.js";

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

describe("macOS TUN guard scripts", () => {
  it("embeds the guard byte-exactly inside the grant heredoc", () => {
    const script = grantScript("/c", "dev");
    const match = script.match(
      /cat > "\$guard_tmp" <<'SASH_TUN_GUARD_EOF' &&\n([\s\S]*?)SASH_TUN_GUARD_EOF\n/,
    );
    assert.ok(match, "grant script carries the guard heredoc");
    assert.equal(match[1], MACOS_TUN_GUARD_SCRIPT);
  });

  it("installs the guard and a validated wheel-owned sudoers rule before the pf anchor", () => {
    const script = grantScript("/c", "dev");
    assert.match(script, /chmod 0755 "\$guard_tmp"/);
    assert.match(script, /chown root:wheel "\$guard_tmp"/);
    assert.match(script, /printf '%s\\n' "\$user ALL=\(root\) NOPASSWD: \$guard"/);
    assert.match(script, /chmod 0440 "\$sudoers_tmp"/);
    const visudo = script.indexOf('visudo -cf "$sudoers_tmp"');
    const sudoers = script.indexOf('mv -f "$sudoers_tmp" /etc/sudoers.d/sash-tun-guard');
    const insert = script.indexOf("sash_insert_pf_anchor /etc/pf.conf");
    assert.ok(visudo > 0 && sudoers > visudo && insert > sudoers);
  });

  it("keeps the pf exemption set minimal and blocks every enumerated en interface in both families", () => {
    assert.match(MACOS_TUN_GUARD_SCRIPT, /pass out quick on lo0 all no state/);
    assert.match(MACOS_TUN_GUARD_SCRIPT, /pass out quick proto tcp all user = root no state/);
    assert.match(MACOS_TUN_GUARD_SCRIPT, /pass out quick proto udp all user = root no state/);
    assert.match(MACOS_TUN_GUARD_SCRIPT, /10\.0\.0\.0\/8, 172\.16\.0\.0\/12, 192\.168\.0\.0\/16/);
    assert.match(
      MACOS_TUN_GUARD_SCRIPT,
      /169\.254\.0\.0\/16, 224\.0\.0\.0\/4, 255\.255\.255\.255\/32/,
    );
    assert.match(MACOS_TUN_GUARD_SCRIPT, /fc00::\/7, fe80::\/10, ff00::\/8/);
    assert.match(MACOS_TUN_GUARD_SCRIPT, /for interface in \$physical; do/);
    assert.match(MACOS_TUN_GUARD_SCRIPT, /block return out quick on %s inet all/);
    assert.match(MACOS_TUN_GUARD_SCRIPT, /block return out quick on %s inet6 all/);
    for (const forbidden of ["port { 53, 67, 68, 123 }", "port 53", "port 123"]) {
      assert.equal(MACOS_TUN_GUARD_SCRIPT.includes(forbidden), false, forbidden);
    }
  });

  it("serializes with lockf, manages the pf enable reference, and exposes machine-readable status", () => {
    assert.match(MACOS_TUN_GUARD_SCRIPT, /\/usr\/bin\/lockf -s -t 30 9/);
    assert.match(MACOS_TUN_GUARD_SCRIPT, /\/sbin\/pfctl -E/);
    assert.match(MACOS_TUN_GUARD_SCRIPT, /\/sbin\/pfctl -X "\$token"/);
    assert.match(MACOS_TUN_GUARD_SCRIPT, /main=%s/);
    assert.match(MACOS_TUN_GUARD_SCRIPT, /anchor=%s/);
    assert.match(MACOS_TUN_GUARD_SCRIPT, /rules=%s/);
    assert.match(MACOS_TUN_GUARD_SCRIPT, /pf=%s/);
  });

  it("backs up, validates, inserts and activates the pf.conf anchor exactly once", () => {
    const script = grantScript("/c", "dev");
    assert.match(script, /cp -p "\$pfconf" "\$backup"/);
    assert.match(script, /grep -Fqx 'anchor "dev\.astralyn\.sash"'/);
    assert.match(script, /pfctl" -n -f "\$pfconf"/);
    assert.match(script, /printf '\\n%s\\n' 'anchor "dev\.astralyn\.sash"'/);
    assert.match(script, /sash_activate_pf_anchor \/etc\/pf\.conf \/sbin\/pfctl/);
  });

  it("revoke clears the anchor, removes only the exact pf.conf line, and keeps legacy cleanup", () => {
    const script = revokeScript("/c", "/h", "dev");
    assert.match(script, /sash-tun-guard teardown/);
    assert.match(script, /pfctl -a dev\.astralyn\.sash -F rules/);
    assert.match(script, /rm -f \/etc\/pf\.anchors\/dev\.astralyn\.sash/);
    assert.match(script, /rm -f \/etc\/sudoers\.d\/sash-tun-guard/);
    assert.match(script, /awk -v line='anchor "dev\.astralyn\.sash"' '\$0 != line'/);
    assert.match(script, /launchctl bootout "system\/\$legacy"/);
  });

  it("revoke removes the guard lock file, the pf token and the state directory", () => {
    const script = revokeScript("/c", "/h", "dev");
    assert.match(script, /rm -f \/var\/run\/sash-tun-guard\.lock/);
    assert.match(script, /rm -f \/var\/run\/sash-tun-guard\/pf\.token/);
    assert.match(script, /rmdir \/var\/run\/sash-tun-guard 2>\/dev\/null \|\| true/);
    const teardown = script.indexOf("sash-tun-guard teardown");
    const lockRemoval = script.indexOf("rm -f /var/run/sash-tun-guard.lock");
    assert.ok(
      teardown > 0 && lockRemoval > teardown,
      "the guard releases its pf reference before the lock goes away",
    );
  });
});

const shAvailable = spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0;

describe.skipIf(!shAvailable)("pf.conf edit shell behavior", () => {
  function posix(file: string): string {
    return file.replace(/\\/g, "/");
  }

  function rig() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-pf-edit-"));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    const pfctl = path.join(root, "bin", "pfctl");
    fs.writeFileSync(
      pfctl,
      '#!/bin/sh\nif [ "$1" = "-n" ] && /usr/bin/grep -q INVALID "$3" 2>/dev/null; then exit 1; fi\nexit 0\n',
      { mode: 0o755 },
    );
    return {
      root,
      pfconf: path.join(root, "pf.conf"),
      backup: path.join(root, "pf.conf.sash-backup"),
      pfctl,
    };
  }

  function runEdit(verb: "insert" | "remove", fixture: ReturnType<typeof rig>) {
    const call =
      verb === "insert"
        ? `sash_insert_pf_anchor ${shellQuote(posix(fixture.pfconf))} ${shellQuote(posix(fixture.backup))} ${shellQuote(posix(fixture.pfctl))}`
        : `sash_remove_pf_anchor ${shellQuote(posix(fixture.pfconf))}`;
    return spawnSync("sh", ["-c", `${PF_CONF_EDIT_FUNCTIONS}\n${call}\n`], { encoding: "utf8" });
  }

  it("inserts the anchor once and preserves the first backup", () => {
    const fixture = rig();
    const original =
      'anchor "com.apple/*"\nload anchor "com.apple" from "/etc/pf.anchors/com.apple"\n';
    fs.writeFileSync(fixture.pfconf, original);
    assert.equal(runEdit("insert", fixture).status, 0);
    const inserted = fs.readFileSync(fixture.pfconf, "utf8");
    assert.equal(inserted.split(MACOS_PF_ANCHOR_LINE).length - 1, 1);
    assert.equal(fs.readFileSync(fixture.backup, "utf8"), original);

    fs.writeFileSync(fixture.backup, "first backup");
    assert.equal(runEdit("insert", fixture).status, 0);
    assert.equal(fs.readFileSync(fixture.pfconf, "utf8"), inserted);
    assert.equal(fs.readFileSync(fixture.backup, "utf8"), "first backup");
  });

  it("refuses abnormal content without editing or backing up", () => {
    const fixture = rig();
    fs.writeFileSync(fixture.pfconf, "INVALID\n");
    const result = runEdit("insert", fixture);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(fixture.pfconf, "utf8"), "INVALID\n");
    assert.equal(fs.existsSync(fixture.backup), false);
  });

  it("deletes only the exact anchor line and preserves foreign content", () => {
    const fixture = rig();
    const foreign = '  anchor "dev.astralyn.sash"  # hand-written variant\n';
    fs.writeFileSync(fixture.pfconf, `before\n${MACOS_PF_ANCHOR_LINE}\n${foreign}after\n`);
    assert.equal(runEdit("remove", fixture).status, 0);
    assert.equal(fs.readFileSync(fixture.pfconf, "utf8"), `before\n${foreign}after\n`);
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
