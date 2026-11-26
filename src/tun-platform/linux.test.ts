import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, onTestFinished } from "vitest";
import { sashLayout } from "../paths.js";
import {
  CORE_CAPABILITIES,
  elevationCommand,
  GRANT_SCRIPT,
  linuxTunPlatform,
  parseGetcap,
  REVOKE_SCRIPT,
  type Runner,
  resolveHelperAuth,
  TUN_GUARD_SCRIPT,
} from "./linux.js";

function layoutWithCore(core = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-linux-tun-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = sashLayout(root);
  if (core) {
    fs.mkdirSync(path.dirname(layout.coreExe), { recursive: true });
    fs.writeFileSync(layout.coreExe, "core");
  }
  return layout;
}

function binWith(...names: string[]): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sash-linux-bin-"));
  onTestFinished(() => fs.rmSync(bin, { recursive: true, force: true }));
  for (const name of names) fs.writeFileSync(path.join(bin, name), "", { mode: 0o755 });
  return bin;
}

function helperAuthFile(layout: ReturnType<typeof layoutWithCore>): string {
  return path.join(layout.stateDir, "tun-helper-auth");
}

describe("parseGetcap", () => {
  const core = "/home/a/.local/share/sash/bin/mihomo";
  it("accepts current and older libcap output", () => {
    assert.equal(parseGetcap(`${core} cap_net_bind_service,cap_net_admin=ep\n`, core), true);
    assert.equal(parseGetcap(`${core} = cap_net_admin,cap_net_bind_service+ep\n`, core), true);
    assert.equal(parseGetcap(`${core} cap_net_admin+ep cap_net_bind_service+eip\n`, core), true);
  });

  it("rejects missing, partial or inheritable-only capabilities", () => {
    assert.equal(parseGetcap("", core), false);
    assert.equal(parseGetcap(`${core} cap_net_admin=ep\n`, core), false);
    assert.equal(parseGetcap(`${core} cap_net_admin,cap_net_bind_service=i\n`, core), false);
  });

  it("does not read capability names out of the file path", () => {
    const odd = "/tmp/cap_net_admin,cap_net_bind_service=ep/mihomo";
    assert.equal(parseGetcap(`${odd}\n`, odd), false);
  });
});

describe("Linux scripts", () => {
  it("grant the documented capabilities to the Core passed as $1", () => {
    assert.equal(CORE_CAPABILITIES, "cap_net_admin,cap_net_bind_service=+ep");
    assert.match(GRANT_SCRIPT, /setcap cap_net_admin,cap_net_bind_service=\+ep "\$core"/);
    assert.match(GRANT_SCRIPT, /core="\$1"/);
    assert.match(GRANT_SCRIPT, /\[ -L "\$core" \]/);
    assert.match(REVOKE_SCRIPT, /setcap -r "\$core"/);
  });

  it("retire the 0.7.0 systemd helper", () => {
    for (const script of [GRANT_SCRIPT, REVOKE_SCRIPT]) {
      assert.match(script, /systemctl disable --now sash-helper\.service/);
      assert.match(script, /rm -rf \/usr\/local\/lib\/sash \/var\/lib\/sash-helper/);
    }
  });
});

describe("TUN guard scripts", () => {
  it("embeds the guard script byte-exactly inside the grant heredoc", () => {
    const match = GRANT_SCRIPT.match(
      /cat > "\$guard_tmp" <<'SASH_TUN_GUARD_EOF' &&\n([\s\S]*?)SASH_TUN_GUARD_EOF\n/,
    );
    assert.ok(match, "grant script carries the guard heredoc");
    assert.equal(match[1], TUN_GUARD_SCRIPT);
  });

  it("writes the guard atomically as root-owned 0755", () => {
    assert.match(GRANT_SCRIPT, /\.sash-tun-guard\.new\.\$\$/);
    assert.match(GRANT_SCRIPT, /chmod 0755 "\$guard_tmp"/);
    assert.match(GRANT_SCRIPT, /chown root:root "\$guard_tmp"/);
    assert.match(GRANT_SCRIPT, /mv -f "\$guard_tmp" "\$guard"/);
    assert.match(GRANT_SCRIPT, /mkdir -p \/usr\/local\/libexec/);
  });

  it("installs a per-user nopasswd sudoers rule validated by visudo before enabling", () => {
    assert.match(
      GRANT_SCRIPT,
      /printf '%s\\n' "\$sudoers_user ALL=\(root\) NOPASSWD: \$guard" > "\$sudoers_tmp"/,
    );
    assert.match(GRANT_SCRIPT, /chmod 0440 "\$sudoers_tmp"/);
    const visudo = GRANT_SCRIPT.indexOf('visudo -cf "$sudoers_tmp"');
    const enable = GRANT_SCRIPT.indexOf('mv -f "$sudoers_tmp" /etc/sudoers.d/sash-tun-guard');
    assert.ok(visudo > 0 && enable > visudo, "visudo validates before the rule is enabled");
  });

  it("derives the sudoers user from the elevation environment only", () => {
    assert.match(GRANT_SCRIPT, /printenv SUDO_USER/);
    assert.match(GRANT_SCRIPT, /printenv PKEXEC_UID/);
    assert.match(GRANT_SCRIPT, /id -nu "\$pkexec_uid"/);
    assert.match(GRANT_SCRIPT, /case \$sudoers_user in/);
  });

  it("degrades to warnings instead of failing the grant", () => {
    assert.match(GRANT_SCRIPT, /warning: sudo is not installed/);
    assert.match(GRANT_SCRIPT, /warning: could not install the sudoers rule/);
    assert.match(GRANT_SCRIPT, /warning: could not install \$guard/);
  });

  it("guard script: validates device strictly before any work", () => {
    const validate = TUN_GUARD_SCRIPT.indexOf("*[!a-zA-Z0-9._-]*");
    const flock = TUN_GUARD_SCRIPT.indexOf("flock -w 30 9");
    assert.ok(validate > 0 && validate < flock, "device validation precedes the lock");
    assert.match(TUN_GUARD_SCRIPT, /\$\{#device\} -gt 32/);
  });

  it("guard script: setup installs blackhole first, then configures resolved with retries", () => {
    const v4 = TUN_GUARD_SCRIPT.indexOf("ip route replace blackhole default metric 100");
    const v6 = TUN_GUARD_SCRIPT.indexOf("ip -6 route replace blackhole default metric 100");
    const wait = TUN_GUARD_SCRIPT.indexOf('ip link show dev "$device"');
    const dns = TUN_GUARD_SCRIPT.indexOf('resolvectl dns "$device" 198.18.0.2');
    assert.ok(v4 > 0 && v6 > v4, "v4 blackhole before v6");
    assert.ok(wait > v6, "blackhole does not wait for the interface");
    assert.ok(dns > wait, "resolved configuration follows the interface wait");
    assert.match(TUN_GUARD_SCRIPT, /ip -6 route replace blackhole[^\n]*\|\| true/);
    assert.match(TUN_GUARD_SCRIPT, /resolvectl domain "\$device" "~\."/);
    assert.match(TUN_GUARD_SCRIPT, /resolvectl default-route "\$device" true/);
    assert.match(TUN_GUARD_SCRIPT, /while \[ \$attempt -le 5 \]/);
    assert.match(TUN_GUARD_SCRIPT, /while \[ \$waited -lt 50 \]/);
    assert.match(TUN_GUARD_SCRIPT, /grep -F "198\.18\.0\.2"/);
    assert.match(TUN_GUARD_SCRIPT, /grep -F "~\."/);
  });

  it("guard script: runs single-instance under flock with a bounded wait", () => {
    assert.match(TUN_GUARD_SCRIPT, /exec 9>\/run\/sash-tun-guard\.lock/);
    assert.match(TUN_GUARD_SCRIPT, /flock -w 30 9/);
    assert.match(TUN_GUARD_SCRIPT, /^set -eu$/m);
  });

  it("guard script: skips resolved integration unless resolved is really in use", () => {
    assert.match(TUN_GUARD_SCRIPT, /command -v resolvectl/);
    assert.match(TUN_GUARD_SCRIPT, /systemctl is-active --quiet systemd-resolved/);
  });

  it("guard script: teardown removes both blackhole routes idempotently", () => {
    assert.match(
      TUN_GUARD_SCRIPT,
      /ip route del blackhole default metric 100 table "\$table" 2>\/dev\/null \|\| true/,
    );
    assert.match(
      TUN_GUARD_SCRIPT,
      /ip -6 route del blackhole default metric 100 table "\$table" 2>\/dev\/null \|\| true/,
    );
  });

  it("revoke removes the sudoers rule, the guard script and the blackhole routes", () => {
    assert.match(REVOKE_SCRIPT, /rm -f \/etc\/sudoers\.d\/sash-tun-guard/);
    assert.match(REVOKE_SCRIPT, /rm -f \/usr\/local\/libexec\/sash-tun-guard/);
    assert.match(REVOKE_SCRIPT, /ip route del blackhole default metric 100 table 2022/);
    assert.match(REVOKE_SCRIPT, /ip -6 route del blackhole default metric 100 table 2022/);
    assert.match(REVOKE_SCRIPT, /resolvectl revert Meta/);
  });

  it("keeps the fixed table number mihomo uses", () => {
    assert.match(TUN_GUARD_SCRIPT, /table=2022/);
    assert.match(REVOKE_SCRIPT, /table 2022/);
  });

  it("uses no template-literal interpolation artifacts", () => {
    for (const script of [GRANT_SCRIPT, REVOKE_SCRIPT, TUN_GUARD_SCRIPT]) {
      assert.equal(script.includes("undefined"), false);
      assert.equal(script.includes("\r"), false);
    }
  });
});

describe.skipIf(process.platform !== "linux")("TUN guard shell behavior", () => {
  const sh = "/bin/sh";

  function writeRig(root: string): void {
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    fs.mkdirSync(path.join(root, "run"), { recursive: true });
    const stub = (name: string, body: string) => {
      fs.writeFileSync(path.join(root, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    stub(
      "ip",
      `echo "ip $*" >> "$RIG/log"
case "$1 $2" in
  "link show") [ -f "$RIG/state/link-up" ] && exit 0 || exit 1 ;;
  "route del") exit 1 ;;
esac
exit 0`,
    );
    stub("flock", 'echo "flock $*" >> "$RIG/log"\nexit 0');
    stub("systemctl", '[ -f "$RIG/state/resolved-active" ] && exit 0 || exit 3');
  }

  function guardUnderTest(root: string): string {
    const script = path.join(root, "guard.sh");
    fs.writeFileSync(
      script,
      TUN_GUARD_SCRIPT.replace("/run/sash-tun-guard.lock", path.join(root, "run", "lock")),
    );
    return script;
  }

  async function runGuard(
    root: string,
    args: string[],
  ): Promise<{ code: number | null; stderr: string }> {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
      execFile(
        sh,
        [guardUnderTest(root), ...args],
        {
          env: { PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`, RIG: root },
          timeout: 30_000,
        },
        (error, _stdout, stderr) => {
          resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
        },
      );
    });
  }

  function rig() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-guard-rig-"));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    writeRig(root);
    return root;
  }

  function log(root: string): string {
    try {
      return fs.readFileSync(path.join(root, "log"), "utf8");
    } catch {
      return "";
    }
  }

  it("installs blackhole routes before touching resolved", async () => {
    const root = rig();
    fs.writeFileSync(
      path.join(root, "bin", "resolvectl"),
      '#!/bin/sh\necho "resolvectl $*" >> "$RIG/log"\nif [ "$1" = "status" ]; then echo "DNS Servers: 198.18.0.2"; echo "DNS Domain: ~."; fi\nexit 0\n',
      { mode: 0o755 },
    );
    for (const marker of ["link-up", "resolved-active"]) {
      fs.writeFileSync(path.join(root, "state", marker), "");
    }
    const result = await runGuard(root, ["setup", "Meta"]);
    assert.equal(result.code, 0, result.stderr);
    const lines = log(root).split("\n");
    const blackhole = lines.findIndex((line) => line.includes("route replace blackhole"));
    const link = lines.findIndex((line) => line.includes("link show"));
    const dns = lines.findIndex((line) => line.includes("resolvectl dns"));
    assert.ok(blackhole > 0 && blackhole < link && link < dns, log(root));
  });

  it("rejects an invalid device before any work", async () => {
    const root = rig();
    const result = await runGuard(root, ["setup", "bad;name"]);
    assert.equal(result.code, 2);
    assert.equal(log(root), "");
  });

  it("teardown removes routes and tolerates their absence", async () => {
    const root = rig();
    const first = await runGuard(root, ["teardown"]);
    const second = await runGuard(root, ["teardown"]);
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    assert.match(log(root), /route del blackhole default metric 100/);
  });

  it("exits nonzero when the interface never appears but keeps the blackhole", async () => {
    const root = rig();
    fs.writeFileSync(path.join(root, "state", "resolved-active"), "");
    const script = guardUnderTest(root);
    fs.writeFileSync(script, fs.readFileSync(script, "utf8").replace("-lt 50", "-lt 3"));
    const result = await runGuard(root, ["setup", "Meta"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /did not appear/);
    assert.match(log(root), /route replace blackhole/);
  });

  it("skips resolved configuration when systemd-resolved is inactive", async () => {
    const root = rig();
    fs.writeFileSync(path.join(root, "state", "link-up"), "");
    const result = await runGuard(root, ["setup", "Meta"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(log(root).includes("resolvectl dns"), false);
    assert.match(log(root), /route replace blackhole/);
  });
});

describe.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
  "elevationCommand",
  () => {
    it("prefers pkexec and uses sudo only when asked", () => {
      const bin = binWith("pkexec", "sudo");
      assert.deepEqual(elevationCommand({ PATH: bin }), {
        cmd: path.join(bin, "pkexec"),
        args: ["/bin/sh", "-s"],
      });
      assert.deepEqual(elevationCommand({ PATH: bin }, "sudo"), {
        cmd: path.join(bin, "sudo"),
        args: ["-n", "/bin/sh", "-s"],
      });
      assert.throws(() => elevationCommand({ PATH: "" }), /needs pkexec/);
    });

    it("ignores SASH_TUN_HELPER_AUTH in the environment it is given", () => {
      const bin = binWith("pkexec", "sudo");
      assert.deepEqual(elevationCommand({ PATH: bin, SASH_TUN_HELPER_AUTH: "sudo" }), {
        cmd: path.join(bin, "pkexec"),
        args: ["/bin/sh", "-s"],
      });
    });

    it("does not mutate the environment it is given", () => {
      const bin = binWith("pkexec", "sudo");
      const env = { PATH: bin, SASH_TUN_HELPER_AUTH: "sudo" };
      elevationCommand(env, "sudo");
      assert.deepEqual(env, { PATH: bin, SASH_TUN_HELPER_AUTH: "sudo" });
    });

    it("falls back to pkexec when sudo is preferred but absent", () => {
      const bin = binWith("pkexec");
      assert.deepEqual(elevationCommand({ PATH: bin }, "sudo"), {
        cmd: path.join(bin, "pkexec"),
        args: ["/bin/sh", "-s"],
      });
    });
  },
);

describe("resolveHelperAuth", () => {
  function layoutWithStoredHelperAuth(content?: string) {
    const layout = layoutWithCore();
    fs.mkdirSync(layout.stateDir, { recursive: true });
    if (content !== undefined)
      fs.writeFileSync(path.join(layout.stateDir, "tun-helper-auth"), content);
    return layout;
  }

  it("uses the stored sudo preference when the environment has none", () => {
    assert.equal(resolveHelperAuth(layoutWithStoredHelperAuth("sudo\n"), { PATH: "" }), "sudo");
  });

  it("lets an explicit request or environment choice override the stored preference", () => {
    const layout = layoutWithStoredHelperAuth("sudo\n");
    assert.equal(resolveHelperAuth(layout, { PATH: "" }, { helperAuth: "pkexec" }), "pkexec");
    assert.equal(resolveHelperAuth(layout, { PATH: "", SASH_TUN_HELPER_AUTH: "pkexec" }), "pkexec");
    assert.equal(
      resolveHelperAuth(layoutWithCore(), { PATH: "", SASH_TUN_HELPER_AUTH: " sudo " }),
      "sudo",
    );
    assert.equal(
      resolveHelperAuth(
        layoutWithCore(),
        { PATH: "", SASH_TUN_HELPER_AUTH: "pkexec" },
        { helperAuth: "sudo" },
      ),
      "sudo",
    );
  });

  it("ignores an invalid environment value instead of overriding the stored preference", () => {
    assert.equal(
      resolveHelperAuth(layoutWithStoredHelperAuth("sudo\n"), {
        PATH: "",
        SASH_TUN_HELPER_AUTH: "typo",
      }),
      "sudo",
    );
    assert.equal(
      resolveHelperAuth(layoutWithCore(), { PATH: "", SASH_TUN_HELPER_AUTH: "typo" }),
      undefined,
    );
    assert.equal(
      resolveHelperAuth(layoutWithCore(), { PATH: "", SASH_TUN_HELPER_AUTH: "  " }),
      undefined,
    );
  });

  it("treats the stored file as a remember-sudo boolean", () => {
    assert.equal(
      resolveHelperAuth(layoutWithStoredHelperAuth("pkexec\n"), { PATH: "" }),
      undefined,
    );
    assert.equal(
      resolveHelperAuth(layoutWithStoredHelperAuth("garbage\n"), { PATH: "" }),
      undefined,
    );
    assert.equal(resolveHelperAuth(layoutWithCore(), { PATH: "" }), undefined);
  });

  it("resolves without re-encoding or mutating the environment", () => {
    const env = { PATH: "", SASH_TUN_HELPER_AUTH: "typo" };
    assert.equal(resolveHelperAuth(layoutWithStoredHelperAuth("sudo\n"), env), "sudo");
    assert.deepEqual(env, { PATH: "", SASH_TUN_HELPER_AUTH: "typo" });
  });
});

describe("linuxTunPlatform.inspect", () => {
  it("reads the Core's capabilities with getcap", async () => {
    const layout = layoutWithCore();
    const calls: string[][] = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return `${layout.coreExe} cap_net_admin,cap_net_bind_service=ep\n`;
    };
    const getcapDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-getcap-"));
    onTestFinished(() => fs.rmSync(getcapDir, { recursive: true, force: true }));
    const getcap = path.join(getcapDir, "getcap");
    fs.writeFileSync(getcap, "", { mode: 0o755 });
    const platform = linuxTunPlatform({ run, env: { PATH: getcapDir } });
    assert.deepEqual(await platform.inspect(layout), { state: "ready" });
    assert.equal(calls[0]?.[1], layout.coreExe);
  });

  it("reports a missing Core without running getcap", async () => {
    const platform = linuxTunPlatform({
      run: async () => {
        throw new Error("getcap must not run");
      },
      env: { PATH: "" },
    });
    assert.equal((await platform.inspect(layoutWithCore(false))).state, "missing");
  });

  it("refuses to authorize before the Core is installed", async () => {
    const platform = linuxTunPlatform({ run: async () => "", env: { PATH: "" } });
    await assert.rejects(platform.install(layoutWithCore(false)), /Core is not installed/);
  });
});

describe("linuxTunPlatform elevation", () => {
  function recordingRunner(failure?: string) {
    const calls: { cmd: string; args: string[]; input?: string }[] = [];
    const run: Runner = async (cmd, args, options) => {
      calls.push({ cmd, args, input: options.input });
      if (failure) throw new Error(failure);
      return "";
    };
    return { calls, run };
  }

  it("passes the script on stdin with the Core path after --", async () => {
    const layout = layoutWithCore();
    const { calls, run } = recordingRunner();
    const platform = linuxTunPlatform({ run, env: { PATH: binWith("pkexec") } });
    await platform.install(layout);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args.slice(-2), ["--", layout.coreExe]);
    assert.equal(calls[0]?.input, GRANT_SCRIPT);
  });

  it.skipIf(process.geteuid?.() === 0)(
    "remembers sudo after a successful explicitly-sudo install",
    async () => {
      const bin = binWith("sudo", "pkexec");
      const layout = layoutWithCore();
      const { calls, run } = recordingRunner();
      const platform = linuxTunPlatform({ run, env: { PATH: bin } });
      await platform.install(layout, { helperAuth: "sudo" });
      assert.equal(calls[0]?.cmd, path.join(bin, "sudo"));
      assert.deepEqual(calls[0]?.args.slice(0, 3), ["-n", "/bin/sh", "-s"]);

      await platform.install(layout);
      assert.equal(calls[1]?.cmd, path.join(bin, "sudo"), "the stored preference keeps sudo");
    },
  );

  it.skipIf(process.geteuid?.() === 0)(
    "remembers sudo when the injected environment asks for it",
    async () => {
      const bin = binWith("sudo", "pkexec");
      const layout = layoutWithCore();
      const { calls, run } = recordingRunner();
      await linuxTunPlatform({
        run,
        env: { PATH: bin, SASH_TUN_HELPER_AUTH: "sudo" },
      }).install(layout);
      assert.equal(calls[0]?.cmd, path.join(bin, "sudo"));

      await linuxTunPlatform({ run, env: { PATH: bin } }).install(layout);
      assert.equal(
        calls[1]?.cmd,
        path.join(bin, "sudo"),
        "the stored preference outlives the environment choice",
      );
    },
  );

  it.skipIf(process.geteuid?.() === 0)(
    "does not remember sudo when the run fails, and wraps the failure",
    async () => {
      const bin = binWith("sudo", "pkexec");
      const layout = layoutWithCore();
      const { run } = recordingRunner("dismissed by the user");
      const platform = linuxTunPlatform({ run, env: { PATH: bin } });
      await assert.rejects(
        platform.install(layout, { helperAuth: "sudo" }),
        /Could not authorize the Core for TUN Mode: dismissed by the user\. Approve the pkexec prompt/,
      );
      assert.equal(fs.existsSync(helperAuthFile(layout)), false);

      const retry = recordingRunner();
      await linuxTunPlatform({ run: retry.run, env: { PATH: bin } }).install(layout);
      assert.equal(retry.calls[0]?.cmd, path.join(bin, "pkexec"), "nothing was remembered");
    },
  );

  it.skipIf(process.geteuid?.() === 0)(
    "an explicit pkexec forgets the stored sudo preference before running",
    async () => {
      const bin = binWith("sudo", "pkexec");
      const layout = layoutWithCore();
      fs.mkdirSync(layout.stateDir, { recursive: true });
      fs.writeFileSync(helperAuthFile(layout), "sudo\n");
      let existedDuringRun: boolean | undefined;
      const calls: string[] = [];
      const run: Runner = async (cmd) => {
        calls.push(cmd);
        existedDuringRun = fs.existsSync(helperAuthFile(layout));
        return "";
      };
      const platform = linuxTunPlatform({ run, env: { PATH: bin } });
      await platform.install(layout, { helperAuth: "pkexec" });
      assert.equal(existedDuringRun, false, "the preference is gone before elevation runs");
      assert.equal(fs.existsSync(helperAuthFile(layout)), false);
      assert.equal(calls[0], path.join(bin, "pkexec"));
    },
  );
});
