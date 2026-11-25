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
  helperAuthEnvironment,
  linuxTunPlatform,
  parseGetcap,
  REVOKE_SCRIPT,
  type Runner,
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

describe("elevationCommand", () => {
  it.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
    "prefers pkexec and uses sudo only when asked",
    () => {
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sash-linux-bin-"));
      onTestFinished(() => fs.rmSync(bin, { recursive: true, force: true }));
      for (const name of ["pkexec", "sudo"])
        fs.writeFileSync(path.join(bin, name), "", { mode: 0o755 });
      assert.deepEqual(elevationCommand({ PATH: bin }), {
        cmd: path.join(bin, "pkexec"),
        args: ["/bin/sh", "-s"],
      });
      assert.deepEqual(elevationCommand({ PATH: bin, SASH_TUN_HELPER_AUTH: "sudo" }), {
        cmd: path.join(bin, "sudo"),
        args: ["-n", "/bin/sh", "-s"],
      });
      assert.throws(() => elevationCommand({ PATH: "" }), /needs pkexec/);
    },
  );
});

describe("helperAuthEnvironment", () => {
  it("uses the stored sudo preference when the daemon environment has none", () => {
    const layout = layoutWithCore();
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(path.join(layout.stateDir, "tun-helper-auth"), "sudo\n");
    const resolved = helperAuthEnvironment({ PATH: "" }, layout);
    assert.equal(resolved.env.SASH_TUN_HELPER_AUTH, "sudo");
    assert.equal(resolved.explicit, undefined);
  });

  it("lets an explicit request or environment choice override the stored preference", () => {
    const layout = layoutWithCore();
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(path.join(layout.stateDir, "tun-helper-auth"), "sudo\n");
    assert.equal(
      helperAuthEnvironment({ PATH: "" }, layout, { helperAuth: "pkexec" }).env
        .SASH_TUN_HELPER_AUTH,
      "pkexec",
    );
    assert.equal(
      helperAuthEnvironment({ PATH: "", SASH_TUN_HELPER_AUTH: "sudo" }, layout).explicit,
      "sudo",
    );
    assert.equal(
      helperAuthEnvironment({ PATH: "", SASH_TUN_HELPER_AUTH: "typo" }, layout).env
        .SASH_TUN_HELPER_AUTH,
      "pkexec",
    );
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
