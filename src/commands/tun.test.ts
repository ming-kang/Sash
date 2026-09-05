import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { DaemonStatus, SettingsPatch } from "../contracts.js";
import { sashLayout } from "../paths.js";
import { SashApiError } from "../sash-client.js";
import { DEFAULT_SETTINGS, publicSettings, saveSettings } from "../settings.js";
import type { TunServiceDeps } from "../tun-service.js";
import { runTun } from "./tun.js";

let root: string;
let previousHome: string | undefined;
let originalLog: typeof console.log;
let originalWarn: typeof console.warn;
let output: string[];
let warnings: string[];
const settings = {
  ...DEFAULT_SETTINGS,
  mixedPort: 27890,
  controller: "127.0.0.1:29090",
  daemonPort: 39090,
  secret: "test-core-secret",
  daemonSecret: "test-daemon-secret",
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-tun-command-"));
  previousHome = process.env.SASH_HOME;
  process.env.SASH_HOME = root;
  saveSettings(settings, sashLayout(root));
  output = [];
  warnings = [];
  originalLog = console.log;
  originalWarn = console.warn;
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  if (previousHome === undefined) delete process.env.SASH_HOME;
  else process.env.SASH_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function online(core: DaemonStatus["core"], desired: boolean) {
  const patches: SettingsPatch[] = [];
  const status: DaemonStatus = {
    daemon: { pid: 123, startedAt: "2026-01-01T00:00:00.000Z", port: settings.daemonPort },
    revisions: { profiles: 0 },
    core,
    settings: publicSettings({ ...settings, tun: desired }),
    systemProxy: { desired: false, applied: false, appliedKnown: true, stateKnown: true },
    activeProfile: null,
  };
  const client = {
    patchSettings: async (patch: SettingsPatch) => {
      patches.push(patch);
      return { settings: status.settings, restartRequired: false };
    },
    status: async (fresh?: boolean) => {
      assert.equal(patches.length, 1, "observe only after a committed mutation");
      assert.equal(fresh, true);
      return status;
    },
  };
  const deps: TunServiceDeps = {
    resolveRuntimeOwner: async (ctx) => {
      assert.equal(ctx.layout.root, root);
      assert.equal(ctx.settings.daemonPort, settings.daemonPort);
      return { kind: "daemon", client };
    },
  };
  return { client, deps, patches };
}

describe("tun command", () => {
  for (const target of ["on", "off"] as const) {
    it(`patches only tun=${target} and reports the committed setting`, async () => {
      const { deps, patches } = online(
        { running: true, healthy: true, tunActive: target === "on" },
        target === "on",
      );
      await runTun(target, deps);
      assert.deepEqual(patches, [{ tun: target === "on" }]);
      assert.match(output.join("\n"), new RegExp(`desired setting saved: ${target}`));
      assert.match(
        output.join("\n"),
        target === "on"
          ? /runtime is active; network connectivity is not verified/
          : /runtime is inactive/,
      );
      assert.deepEqual(warnings, []);
      assert.equal(
        JSON.parse(fs.readFileSync(sashLayout(root).settingsFile, "utf8")).tun,
        false,
        "no offline settings edit",
      );
    });
  }

  it("reports the response setting rather than assuming the requested setting committed", async () => {
    await runTun("on", online({ running: true, tunActive: false }, false).deps);
    assert.match(output.join("\n"), /desired setting saved: off/);
    assert.doesNotMatch(output.join("\n"), /desired setting saved: on/);
  });

  for (const target of ["on", "off"] as const) {
    it(`persists ${target} while Core is stopped without starting it`, async () => {
      const { deps, patches } = online({ running: false }, target === "on");
      await runTun(target, deps);
      assert.deepEqual(patches, [{ tun: target === "on" }]);
      assert.match(output.join("\n"), /Core is stopped.*pending.*sash start.*did not start Core/);
    });
  }

  for (const [core, desired, expected] of [
    [{ running: true, healthy: false, tunActive: true }, true, /Core is unhealthy/],
    [{ running: true, tunActive: true }, true, /Core health is unverified/],
    [
      { running: true, healthy: true, tunActive: false },
      true,
      /TUN is inactive despite the saved on setting/,
    ],
    [{ running: true, healthy: true }, true, /TUN runtime state is unverified/],
    [{ running: true, healthy: true }, false, /TUN runtime state is unverified/],
    [{ running: true, healthy: true, tunActive: true }, false, /TUN remains active unexpectedly/],
  ] as const) {
    it(`distinguishes ${JSON.stringify(core)} with desired=${desired}`, async () => {
      await runTun(desired ? "on" : "off", online(core, desired).deps);
      assert.match(warnings.join("\n"), expected);
      assert.doesNotMatch(output.join("\n"), /runtime is active|runtime is inactive/);
    });
  }

  it("keeps committed success when the subsequent status request fails", async () => {
    const { client, deps } = online({ running: true }, true);
    client.status = async () => {
      throw new Error("observation unavailable");
    };
    await runTun("on", deps);
    assert.match(output.join("\n"), /desired setting saved: on/);
    assert.match(warnings.join("\n"), /could not be observed.*desired setting is saved/);
  });

  for (const code of ["tun_inactive", "tun_unverified"] as const) {
    it(`preserves typed 409 ${code} activation failure unchanged`, async () => {
      const { client, deps } = online({ running: true }, false);
      const error = new SashApiError(409, code, "activation rolled back");
      client.patchSettings = async () => {
        throw error;
      };
      client.status = async () => {
        assert.fail("must not observe a failed mutation");
      };
      await assert.rejects(runTun("on", deps), (err) => err === error);
      assert.deepEqual(output, []);
      assert.deepEqual(warnings, []);
    });
  }

  it("requires sash start when the daemon is stopped", async () => {
    await assert.rejects(
      runTun("on", {
        resolveRuntimeOwner: async () => ({
          kind: "offline",
          daemon: { kind: "stopped", running: false, healthy: false },
        }),
      }),
      /not running.*sash start/,
    );
    assert.deepEqual(output, []);
  });

  it("fails closed for an unhealthy daemon without competing startup", async () => {
    await assert.rejects(
      runTun("off", {
        resolveRuntimeOwner: async () => ({
          kind: "unhealthy",
          daemon: { kind: "unhealthy", running: true, healthy: false },
        }),
      }),
      /unresponsive.*refusing.*competing daemon/,
    );
    assert.deepEqual(output, []);
  });

  it("validates Commander choices and help before creating the data directory", () => {
    const isolatedHome = path.join(root, "untouched-home");
    const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
    for (const args of [
      ["tun", "invalid"],
      ["tun"],
      ["tun", "on", "extra"],
      ["tun", "--help"],
      ["--help"],
    ]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
        env: { ...process.env, SASH_HOME: isolatedHome },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.ifError(result.error);
      if (args.includes("--help")) {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /tun/);
        if (args[0] === "tun") assert.match(result.stdout, /choices: "on", "off"/);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Allowed choices|missing required argument|too many arguments/);
      }
      assert.equal(fs.existsSync(isolatedHome), false, `${args.join(" ")} touched SASH_HOME`);
    }
  });
});
