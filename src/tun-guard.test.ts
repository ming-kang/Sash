import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, onTestFinished, vi } from "vitest";
import { inspectLinuxTunNetwork, TunGuard, type TunGuardRunner } from "./tun-guard.js";

interface RecordedCall {
  cmd: string;
  args: string[];
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeBin(...names: string[]): string {
  const bin = tempDir("sash-guard-bin-");
  for (const name of names) fs.writeFileSync(path.join(bin, name), "", { mode: 0o755 });
  return bin;
}

function guardFixture(
  options: {
    platform?: string;
    asRoot?: boolean;
    scriptInstalled?: boolean;
    run?: TunGuardRunner;
    now?: () => number;
  } = {},
) {
  const root = tempDir("sash-guard-test-");
  const scriptPath = path.join(root, "sash-tun-guard");
  if (options.scriptInstalled !== false) fs.writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n");
  const bin = fakeBin("sudo");
  const sudo = path.join(bin, "sudo");
  const calls: RecordedCall[] = [];
  const recording =
    (behavior?: TunGuardRunner): TunGuardRunner =>
    async (cmd, args, callOptions) => {
      calls.push({ cmd, args: [...args] });
      return behavior ? behavior(cmd, args, callOptions) : "";
    };
  const guard = new TunGuard({
    platform: options.platform ?? "linux",
    scriptPath,
    env: { PATH: bin },
    asRoot: options.asRoot ?? false,
    run: recording(options.run),
    ...(options.now ? { now: options.now } : {}),
  });
  return { guard, calls, scriptPath, sudo, bin };
}

function guardInvocations(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.args[0] !== "-l" && !call.args.includes("-l"));
}

describe("TunGuard platform dispatch", () => {
  it("does nothing on unsupported platforms", async () => {
    const { guard, calls } = guardFixture({ platform: "win32" });
    assert.equal(guard.supported, false);
    await guard.reconcile("setup", {});
    await guard.reconcile("teardown", {});
    assert.deepEqual(calls, []);
    assert.equal(guard.lastResult(), undefined);
  });

  it("supports linux and darwin", () => {
    assert.equal(new TunGuard({ platform: "linux" }).supported, true);
    assert.equal(new TunGuard({ platform: "darwin" }).supported, true);
    assert.equal(new TunGuard({ platform: "freebsd" }).supported, false);
  });
});

describe("TunGuard invocation", () => {
  it("probes sudo authorization once and invokes through sudo -n", async () => {
    const { guard, calls, scriptPath, sudo } = guardFixture();
    await guard.reconcile("setup", {});
    assert.deepEqual(
      calls.map((call) => [call.cmd, ...call.args]),
      [
        [sudo, "-n", "-l", scriptPath],
        [sudo, "-n", scriptPath, "setup", "Meta"],
      ],
    );
    assert.equal(guard.lastResult()?.state, "ok");
    assert.equal(guard.lastResult()?.verb, "setup");
  });

  it("passes a configured device name to setup", async () => {
    const { guard, calls, scriptPath, sudo } = guardFixture();
    await guard.reconcile("setup", { device: "tun7" });
    const invocation = calls.find((call) => !call.args.includes("-l"));
    assert.deepEqual(invocation?.args, ["-n", scriptPath, "setup", "tun7"]);
    assert.equal(invocation?.cmd, sudo);
  });

  it("defaults to the Meta interface only on linux", async () => {
    const linux = guardFixture({ platform: "linux" });
    await linux.guard.reconcile("setup", {});
    assert.deepEqual(guardInvocations(linux.calls)[0]?.args.slice(-2), ["setup", "Meta"]);

    const darwin = guardFixture({ platform: "darwin" });
    await darwin.guard.reconcile("setup", {});
    assert.deepEqual(guardInvocations(darwin.calls)[0]?.args.slice(-2), [
      darwin.scriptPath,
      "setup",
    ]);

    await darwin.guard.reconcile("setup", { device: "utun5" });
    assert.deepEqual(guardInvocations(darwin.calls)[1]?.args.slice(-2), ["setup", "utun5"]);
  });

  it("invokes the script directly as root without sudo", async () => {
    const { guard, calls, scriptPath } = guardFixture({ asRoot: true });
    await guard.reconcile("setup", {});
    assert.deepEqual(
      calls.map((call) => [call.cmd, ...call.args]),
      [[scriptPath, "setup", "Meta"]],
    );
  });

  it("refuses invalid device names without invoking anything", async () => {
    for (const device of ["", "with space", "a".repeat(33), "../Meta", "Meta;rm", "M\tum"]) {
      const { guard, calls } = guardFixture();
      await guard.reconcile("setup", { device });
      assert.deepEqual(calls, [], `device ${JSON.stringify(device)} must not reach sudo`);
      assert.equal(guard.lastResult()?.state, "failed");
      assert.match(guard.lastResult()?.detail ?? "", /invalid TUN device name/);
    }
  });

  it("accepts boundary-length and punctuation device names", async () => {
    for (const device of ["a".repeat(32), "tun-1_x.y", "-i"]) {
      const { guard, calls } = guardFixture();
      await guard.reconcile("setup", { device });
      assert.deepEqual(guardInvocations(calls)[0]?.args.slice(-2), ["setup", device]);
    }
  });
});

describe("TunGuard availability", () => {
  it("reports setup unavailable when the script is not installed", async () => {
    const { guard, calls } = guardFixture({ scriptInstalled: false });
    await guard.reconcile("setup", {});
    assert.equal(guard.lastResult()?.state, "unavailable");
    assert.match(guard.lastResult()?.detail ?? "", /not installed/);
    assert.deepEqual(calls, []);
  });

  it("skips a teardown silently when nothing was ever installed", async () => {
    const { guard, calls } = guardFixture({ scriptInstalled: false });
    await guard.reconcile("teardown", {});
    assert.equal(guard.lastResult(), undefined);
    assert.deepEqual(calls, []);
  });

  it("reports unavailable when the sudoers grant is missing", async () => {
    const { guard, calls } = guardFixture({
      run: async (_cmd, args) => {
        if (args.includes("-l")) throw new Error("sudo: a password is required");
        return "";
      },
    });
    await guard.reconcile("setup", {});
    assert.equal(guard.lastResult()?.state, "unavailable");
    assert.match(guard.lastResult()?.detail ?? "", /passwordless sudo/);
    assert.equal(
      calls.some((call) => !call.args.includes("-l")),
      false,
      "never invokes",
    );
  });

  it("caches the probe within its ttl and reprobes after", async () => {
    let now = 1_000_000;
    const { guard, calls } = guardFixture({ now: () => now });
    await guard.reconcile("setup", {});
    await guard.reconcile("teardown", {});
    assert.equal(
      calls.filter((call) => call.args.includes("-l")).length,
      1,
      "the second reconcile reuses the probe",
    );
    now += 31_000;
    await guard.reconcile("setup", {});
    assert.equal(calls.filter((call) => call.args.includes("-l")).length, 2, "the probe expires");
  });
});

describe("TunGuard failure degradation", () => {
  it("records failures without rejecting the reconcile promise", async () => {
    const { guard } = guardFixture({
      run: async (_cmd, args) => {
        if (args.includes("-l")) return "";
        throw new Error("ip: command not found");
      },
    });
    await guard.reconcile("setup", {});
    assert.equal(guard.lastResult()?.state, "failed");
    assert.match(guard.lastResult()?.detail ?? "", /command not found/);
  });

  it("warns once per unique failure and again after a success", async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    try {
      let fail = true;
      const { guard } = guardFixture({
        run: async (_cmd, args) => {
          if (args.includes("-l")) return "";
          if (fail) throw new Error("broken");
          return "";
        },
      });
      await guard.reconcile("setup", {});
      await guard.reconcile("setup", {});
      assert.equal(warnings.length, 1, "identical failures warn once");
      assert.match(warnings[0] ?? "", /^\[sashd\] TUN guard setup failed: broken/);

      fail = false;
      await guard.reconcile("setup", {});
      assert.equal(warnings.length, 1, "success is quiet");

      fail = true;
      await guard.reconcile("setup", {});
      assert.equal(warnings.length, 2, "a failure after a success warns again");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("TunGuard serialization", () => {
  function blockingFixture() {
    const gate: { release: Array<() => void> } = { release: [] };
    const fixture = guardFixture({
      run: async (_cmd, args) => {
        if (args.includes("-l")) return "";
        await new Promise<void>((resolve) => gate.release.push(resolve));
        return "";
      },
    });
    return { ...fixture, gate };
  }

  it("never overlaps invocations and coalesces to the latest desired state", async () => {
    const { guard, gate, calls } = blockingFixture();
    const first = guard.reconcile("setup", {});
    const second = guard.reconcile("teardown", {});
    const third = guard.reconcile("setup", { device: "tun3" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(guardInvocations(calls).length, 1, "only the first invocation is in flight");
    for (const release of gate.release.splice(0)) release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      guardInvocations(calls).length,
      2,
      "the queued reconciles merged into one trailing invocation",
    );
    for (const release of gate.release.splice(0)) release();
    await Promise.all([first, second, third]);
    const invocations = guardInvocations(calls);
    assert.deepEqual(
      invocations.map((call) => call.args.slice(-2)),
      [
        ["setup", "Meta"],
        ["setup", "tun3"],
      ],
      "the trailing invocation carries the latest target state",
    );
  });

  it("resolves every waiter after its state was attempted", async () => {
    const { guard, gate } = blockingFixture();
    const order: string[] = [];
    const first = guard.reconcile("setup", {}).then(() => order.push("first"));
    const second = guard.reconcile("teardown", {}).then(() => order.push("second"));
    await new Promise((resolve) => setImmediate(resolve));
    for (const release of gate.release.splice(0)) release();
    await first;
    assert.deepEqual(order, ["first"]);
    for (const release of gate.release.splice(0)) release();
    await second;
    assert.deepEqual(order, ["first", "second"]);
    assert.equal(guard.lastResult()?.verb, "teardown");
  });

  it("drains a reconcile chained from a waiter continuation", async () => {
    const { guard, gate, calls } = blockingFixture();
    const chained = guard.reconcile("setup", {}).then(() => guard.reconcile("teardown", {}));
    await new Promise((resolve) => setImmediate(resolve));
    for (const release of gate.release.splice(0)) release();
    await new Promise((resolve) => setImmediate(resolve));
    for (const release of gate.release.splice(0)) release();
    await chained;
    assert.deepEqual(
      guardInvocations(calls).map((call) => call.args.at(-1)),
      ["Meta", "teardown"],
    );
  });

  it("serializes a rapid sequence of reconciles", async () => {
    const { guard, calls } = guardFixture();
    await Promise.all([
      guard.reconcile("setup", {}),
      guard.reconcile("teardown", {}),
      guard.reconcile("setup", {}),
    ]);
    const invocations = guardInvocations(calls);
    assert.equal(invocations.length <= 2, true, "intermediate states coalesce");
    assert.equal(guard.lastResult()?.verb, "setup");
    assert.equal(guard.lastResult()?.state, "ok");
  });
});

describe("inspectLinuxTunNetwork", () => {
  function runner(responses: Record<string, string | Error>): TunGuardRunner {
    return async (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      for (const [pattern, response] of Object.entries(responses)) {
        if (key.startsWith(pattern)) {
          if (response instanceof Error) throw response;
          return response;
        }
      }
      return "";
    };
  }

  const converged = {
    "ip route show table 2022": "blackhole default metric 100\ndefault via 198.18.0.2 dev Meta\n",
    "ip -6 route show table 2022": "blackhole default metric 100\n",
    "systemctl is-active --quiet systemd-resolved": "",
    "resolvectl status Meta":
      "Link 4 (Meta)\n  Current DNS Server: 198.18.0.2\n         DNS Servers: 198.18.0.2\n          DNS Domain: ~.\n",
  };

  it("is empty off linux", async () => {
    assert.deepEqual(await inspectLinuxTunNetwork({ platform: "darwin" }), []);
    assert.deepEqual(await inspectLinuxTunNetwork({ platform: "win32" }), []);
  });

  it("reports a converged network as ok", async () => {
    const observations = await inspectLinuxTunNetwork({
      platform: "linux",
      run: runner(converged),
    });
    assert.deepEqual(
      observations.map((entry) => [entry.aspect, entry.state]),
      [
        ["blackhole4", "ok"],
        ["blackhole6", "ok"],
        ["resolved", "ok"],
      ],
    );
  });

  it("fails the v4 check without a blackhole route", async () => {
    const observations = await inspectLinuxTunNetwork({
      platform: "linux",
      run: runner({
        ...converged,
        "ip route show table 2022": "default via 198.18.0.2 dev Meta\n",
      }),
    });
    const v4 = observations.find((entry) => entry.aspect === "blackhole4");
    assert.equal(v4?.state, "failed");
    assert.match(v4?.detail ?? "", /falls back to a direct connection/);
  });

  it("checks blackhole lines rather than any output", async () => {
    const observations = await inspectLinuxTunNetwork({
      platform: "linux",
      run: runner({
        ...converged,
        "ip route show table 2022": "default via 198.18.0.2 dev Meta blackhole\n",
      }),
    });
    assert.equal(observations.find((entry) => entry.aspect === "blackhole4")?.state, "failed");
  });

  it("skips the v6 check when the host routes no IPv6", async () => {
    const observations = await inspectLinuxTunNetwork({
      platform: "linux",
      run: runner({ ...converged, "ip -6 route show table 2022": "", "ip -6 route show": "" }),
    });
    assert.equal(
      observations.some((entry) => entry.aspect === "blackhole6"),
      false,
    );
  });

  it("fails the v6 check when IPv6 is routed but unprotected", async () => {
    const observations = await inspectLinuxTunNetwork({
      platform: "linux",
      run: runner({
        ...converged,
        "ip -6 route show table 2022": "",
        "ip -6 route show": "2001:db8::/64 dev ens5 proto kernel\n",
      }),
    });
    assert.equal(observations.find((entry) => entry.aspect === "blackhole6")?.state, "failed");
  });

  it("skips the v6 check when the v6 table cannot be read", async () => {
    const observations = await inspectLinuxTunNetwork({
      platform: "linux",
      run: runner({
        ...converged,
        "ip -6 route show table 2022": new Error("address family not supported"),
        "ip -6 route show": new Error("address family not supported"),
      }),
    });
    assert.equal(
      observations.some((entry) => entry.aspect === "blackhole6"),
      false,
    );
  });

  it("skips the resolved check when systemd-resolved is inactive", async () => {
    const observations = await inspectLinuxTunNetwork({
      platform: "linux",
      run: runner({
        ...converged,
        "systemctl is-active --quiet systemd-resolved": new Error("inactive"),
      }),
    });
    assert.equal(
      observations.some((entry) => entry.aspect === "resolved"),
      false,
    );
  });

  it("fails the resolved check when the link is not bound to the tunnel DNS", async () => {
    const observations = await inspectLinuxTunNetwork({
      platform: "linux",
      run: runner({
        ...converged,
        "resolvectl status Meta": "Link 4 (Meta)\n  DNS Servers: 192.168.1.1\n",
      }),
    });
    const resolved = observations.find((entry) => entry.aspect === "resolved");
    assert.equal(resolved?.state, "failed");
    assert.match(resolved?.detail ?? "", /bypass the tunnel/);
  });

  it("reads the configured device rather than Meta", async () => {
    const seen: string[] = [];
    const observations = await inspectLinuxTunNetwork({
      platform: "linux",
      device: "tun9",
      run: async (cmd, args) => {
        seen.push([cmd, ...args].join(" "));
        if (cmd === "resolvectl") return "DNS Servers: 198.18.0.2\nDNS Domain: ~.\n";
        return "";
      },
    });
    assert.equal(
      seen.some((line) => line === "resolvectl status tun9"),
      true,
    );
    assert.equal(
      seen.some((line) => line === "resolvectl status Meta"),
      false,
    );
    assert.equal(observations.find((entry) => entry.aspect === "resolved")?.state, "ok");
  });

  it("reports unknown when inspection commands fail", async () => {
    const observations = await inspectLinuxTunNetwork({
      platform: "linux",
      run: runner({
        "ip route show table 2022": new Error("ip missing"),
        "systemctl is-active --quiet systemd-resolved": "",
        "resolvectl status Meta": new Error("dbus refused"),
      }),
    });
    assert.equal(observations.find((entry) => entry.aspect === "blackhole4")?.state, "unknown");
    assert.equal(observations.find((entry) => entry.aspect === "resolved")?.state, "unknown");
  });
});
