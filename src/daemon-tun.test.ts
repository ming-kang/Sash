import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import YAML from "yaml";
import { type DaemonStatus, type TunHelperStatus, tunApplyState } from "./contracts.js";
import { readInstallRecord } from "./core.js";
import { CoreStartError, CoreUpdateResumeError } from "./runtime-lifecycle.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";
import { FakeCoreSupervisor } from "./testing/state.js";
import { type TunPlatform, unsupportedTunPlatform } from "./tun-service.js";

describe("daemon TUN controls", () => {
  const harness = useDaemonTestHarness();

  async function tunState() {
    return tunApplyState((await harness.apiRequest("/sash/daemon/status")).data as DaemonStatus);
  }

  function readyTunPlatform(): TunPlatform {
    return {
      ...unsupportedTunPlatform(),
      mechanism: "capabilities",
      inspect: async () => ({ state: "ready" }),
    };
  }

  async function stage() {
    fs.mkdirSync(harness.layout.tempDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(harness.layout.tempDir, "candidate-"));
    const exe = path.join(dir, "candidate");
    fs.writeFileSync(exe, "v2-core");
    return { exe, dir, version: "v2" };
  }

  it("reports unsupported and refuses helper installation on an unsupported platform", async () => {
    await harness.startServer({ tunPlatform: unsupportedTunPlatform() });
    const status = await harness.apiRequest("/sash/tun");
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.data, { state: "unsupported" });
    assert.equal((await harness.apiRequest("/sash/tun", { token: "" })).statusCode, 401);
    assert.equal(
      (await harness.apiRequest("/sash/tun/helper/install", { method: "POST" })).statusCode,
      501,
    );
  });

  it("saves a patch for explicit Apply and rolls back a failed enable", async () => {
    const supervisor = new FakeCoreSupervisor(harness.layout, harness.settings);
    supervisor.onStart = () => {
      const config = YAML.parse(fs.readFileSync(harness.layout.configFile, "utf8"));
      if (config.tun.enable) throw new Error("Mock helper rejected TUN");
    };
    await harness.startServer({
      supervisor,
      tunPlatform: {
        ...unsupportedTunPlatform(),
        mechanism: "capabilities",
        inspect: async () => ({ state: "ready" }),
      },
    });
    assert.equal(
      (await harness.apiRequest("/sash/core/start", { method: "POST" })).statusCode,
      200,
    );
    const write = await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: true } },
    });
    assert.equal(write.statusCode, 200);
    const pending = await tunState();
    assert.equal(pending.desired, true);
    assert.equal(pending.applied, false);
    assert.equal(supervisor.starts, 1);
    const applied = await harness.apiRequest("/sash/core/restart", { method: "POST" });
    assert.notEqual(applied.statusCode, 200);
    const rolledBack = await tunState();
    assert.equal(rolledBack.desired, false);
    assert.equal(rolledBack.applied, false);
    assert.equal(supervisor.running, true);
    assert.equal(YAML.parse(fs.readFileSync(harness.layout.configFile, "utf8")).tun.enable, false);
  });

  it("reports only effective TUN edits as restart pending", async () => {
    const supervisor = new FakeCoreSupervisor(harness.layout, harness.settings);
    await harness.startServer({ supervisor, tunPlatform: readyTunPlatform() });
    assert.equal(
      (await harness.apiRequest("/sash/core/start", { method: "POST" })).statusCode,
      200,
    );

    assert.equal(
      (
        await harness.apiRequest("/sash/settings", {
          method: "PATCH",
          body: { tun: { autoRoute: false } },
        })
      ).statusCode,
      200,
    );
    const dormant = (await harness.apiRequest("/sash/daemon/status")).data as DaemonStatus;
    assert.equal(dormant.configuration.pending, false);
    assert.equal(dormant.configuration.pendingChanges.tun, false);

    assert.equal(
      (
        await harness.apiRequest("/sash/settings", {
          method: "PATCH",
          body: { tun: { enable: true } },
        })
      ).statusCode,
      200,
    );
    const pending = (await harness.apiRequest("/sash/daemon/status")).data as DaemonStatus;
    assert.equal(pending.configuration.pending, true);
    assert.deepEqual(pending.configuration.pendingChanges, {
      profile: false,
      mixedPort: false,
      allowLan: false,
      tun: true,
      runtimeUnknown: false,
    });
    assert.equal(pending.configuration.applyMethod, "restart");
  });

  it("keeps the saved TUN preference when validation fails before any Core start", async () => {
    const supervisor = new FakeCoreSupervisor(harness.layout, harness.settings);
    await harness.startServer({
      supervisor,
      validateConfig: () => {
        throw new Error("rules[0] error: rule is invalid");
      },
      tunPlatform: {
        ...unsupportedTunPlatform(),
        mechanism: "capabilities",
        inspect: async () => ({ state: "ready" }),
      },
    });
    const write = await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: true } },
    });
    assert.equal(write.statusCode, 200);
    const applied = await harness.apiRequest("/sash/core/restart", { method: "POST" });
    assert.notEqual(applied.statusCode, 200);
    assert.match(JSON.stringify(applied.data), /rule is invalid/);
    assert.equal(supervisor.starts, 0);
    const status = await tunState();
    assert.equal(status.desired, true);
    assert.equal(status.applied, false);
  });

  it("keeps the saved TUN preference when a first-install Core download fails", async () => {
    const supervisor = new FakeCoreSupervisor(harness.layout, harness.settings);
    await harness.startServer({
      installCore: false,
      supervisor,
      stageCore: async () => {
        throw new Error("Core download offline");
      },
      tunPlatform: readyTunPlatform(),
    });
    const write = await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: true } },
    });
    assert.equal(write.statusCode, 200);

    const started = await harness.apiRequest("/sash/core/start", { method: "POST" });

    assert.notEqual(started.statusCode, 200);
    assert.match(JSON.stringify(started.data), /Core download offline/);
    assert.equal(supervisor.starts, 0);
    const status = await tunState();
    assert.equal(status.desired, true);
  });

  it("keeps the saved TUN preference when the first-install verification boot fails", async () => {
    const supervisor = new FakeCoreSupervisor(harness.layout, harness.settings);
    supervisor.onStart = () => {
      const config = YAML.parse(fs.readFileSync(harness.layout.configFile, "utf8"));
      if (config.tun?.enable !== true) throw new Error("verification boot failed");
    };
    await harness.startServer({
      installCore: false,
      supervisor,
      stageCore: stage,
      tunPlatform: readyTunPlatform(),
    });
    const write = await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: true } },
    });
    assert.equal(write.statusCode, 200);

    const started = await harness.apiRequest("/sash/core/start", { method: "POST" });

    assert.notEqual(started.statusCode, 200);
    assert.match(JSON.stringify(started.data), /verification boot failed/);
    assert.equal(readInstallRecord(harness.layout), undefined);
    const status = await tunState();
    assert.equal(status.desired, true);
  });

  it("rolls back the saved TUN preference when the verified Core cannot resume TUN", async () => {
    const supervisor = new FakeCoreSupervisor(harness.layout, harness.settings);
    supervisor.onStart = () => {
      const config = YAML.parse(fs.readFileSync(harness.layout.configFile, "utf8"));
      if (config.tun?.enable === true) throw new Error("TUN Core exited during startup");
    };
    await harness.startServer({
      installCore: false,
      supervisor,
      stageCore: stage,
      tunPlatform: readyTunPlatform(),
    });
    const write = await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: true, strictRoute: true, dnsHijack: ["any:53"] } },
    });
    assert.equal(write.statusCode, 200);

    const started = await harness.apiRequest("/sash/core/start", { method: "POST" });

    assert.notEqual(started.statusCode, 200);
    assert.match(
      JSON.stringify(started.data),
      /Core updated to v2, but TUN could not restart: TUN Core exited during startup/,
    );
    assert.equal(readInstallRecord(harness.layout)?.coreVersion, "v2");
    assert.equal(supervisor.running, false);
    const status = await tunState();
    assert.equal(status.desired, false);
    const daemon = (await harness.apiRequest("/sash/daemon/status")).data as DaemonStatus;
    assert.equal(daemon.settings.tun.enable, false);
    assert.equal(daemon.settings.tun.strictRoute, true);
    assert.deepEqual(daemon.settings.tun.dnsHijack, ["any:53"]);
  });

  it("restores TUN after failed update verification and keeps the preference for a plain update", async () => {
    const supervisor = new FakeCoreSupervisor(harness.layout, harness.settings);
    await harness.startServer({
      supervisor,
      stageCore: stage,
      tunPlatform: readyTunPlatform(),
    });
    await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: true } },
    });
    assert.equal(
      (await harness.apiRequest("/sash/core/restart", { method: "POST" })).statusCode,
      200,
    );
    supervisor.onStart = () => {
      if (readInstallRecord(harness.layout)?.coreVersion === "v2") {
        throw new Error("verification boot failed");
      }
    };

    const updated = await harness.apiRequest("/sash/core/update", { method: "POST" });

    assert.notEqual(updated.statusCode, 200);
    assert.match(JSON.stringify(updated.data), /verification boot failed/);
    assert.equal(readInstallRecord(harness.layout)?.coreVersion, "v1.0.0");
    assert.equal(supervisor.running, true);
    assert.equal(YAML.parse(fs.readFileSync(harness.layout.configFile, "utf8")).tun.enable, true);
    const status = await tunState();
    assert.equal(status.desired, true);
    assert.equal(status.applied, true);
  });

  it("throws CoreUpdateResumeError when the first-install TUN resume fails", async () => {
    const supervisor = new FakeCoreSupervisor(harness.layout, harness.settings);
    supervisor.onStart = () => {
      const config = YAML.parse(fs.readFileSync(harness.layout.configFile, "utf8"));
      if (config.tun?.enable === true) throw new Error("TUN Core exited during startup");
    };
    await harness.startServer({
      installCore: false,
      supervisor,
      stageCore: stage,
      tunPlatform: readyTunPlatform(),
    });
    const lifecycle = harness.instance?.lifecycle;
    assert.ok(lifecycle);
    const update = lifecycle.update.bind(lifecycle);
    let updateError: unknown;
    lifecycle.update = async (staged, configuration, startAfterInstall) => {
      try {
        return await update(staged, configuration, startAfterInstall);
      } catch (error) {
        updateError = error;
        throw error;
      }
    };
    const write = await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: true } },
    });
    assert.equal(write.statusCode, 200);

    const started = await harness.apiRequest("/sash/core/start", { method: "POST" });

    assert.notEqual(started.statusCode, 200);
    assert.ok(updateError instanceof CoreUpdateResumeError);
    assert.ok(updateError instanceof CoreStartError);
    assert.equal(updateError.restored, undefined);
    assert.ok(updateError.cause instanceof CoreStartError);
    assert.match(
      (updateError as CoreUpdateResumeError).message,
      /Core updated to v2, but TUN could not restart/,
    );
  });

  it("rolls the saved preference back to enabled when a TUN-disabling start fails", async () => {
    const supervisor = new FakeCoreSupervisor(harness.layout, harness.settings);
    await harness.startServer({
      supervisor,
      tunPlatform: {
        ...unsupportedTunPlatform(),
        mechanism: "capabilities",
        inspect: async () => ({ state: "ready" }),
      },
    });
    await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: true } },
    });
    assert.equal(
      (await harness.apiRequest("/sash/core/restart", { method: "POST" })).statusCode,
      200,
    );
    const running = await tunState();
    assert.equal(running.applied, true);

    await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: false } },
    });
    let failures = 1;
    supervisor.onStart = () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("Core exited during startup");
      }
    };
    const applied = await harness.apiRequest("/sash/core/restart", { method: "POST" });
    assert.notEqual(applied.statusCode, 200);
    const rolledBack = await tunState();
    assert.equal(rolledBack.desired, true);
    assert.equal(rolledBack.applied, true);
    assert.equal(supervisor.running, true);
    assert.equal(YAML.parse(fs.readFileSync(harness.layout.configFile, "utf8")).tun.enable, true);
  });

  it("restores the previous running configuration when a start without TUN fails", async () => {
    const supervisor = new FakeCoreSupervisor(harness.layout, harness.settings);
    await harness.startServer({ supervisor });
    assert.equal(
      (await harness.apiRequest("/sash/core/start", { method: "POST" })).statusCode,
      200,
    );
    const patched = await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { allowLan: true },
    });
    assert.equal(patched.statusCode, 200);
    const before = (await harness.apiRequest("/sash/daemon/status")).data as DaemonStatus;
    let failures = 1;
    supervisor.onStart = () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("Core exited during startup");
      }
    };
    const applied = await harness.apiRequest("/sash/core/restart", { method: "POST" });
    assert.notEqual(applied.statusCode, 200);
    assert.match(JSON.stringify(applied.data), /Core exited during startup/);
    assert.equal(supervisor.starts, 3);
    assert.equal(supervisor.running, true);
    const after = (await harness.apiRequest("/sash/daemon/status")).data as DaemonStatus;
    assert.equal(after.revisions.state, before.revisions.state);
    assert.equal(after.settings.allowLan, true);
    assert.equal(after.configuration.pending, true);
    assert.equal(after.configuration.appliedSettings?.allowLan, false);
    assert.equal(
      YAML.parse(fs.readFileSync(harness.layout.configFile, "utf8"))["allow-lan"],
      false,
    );
    const status = await tunState();
    assert.equal(status.desired, false);
  });

  it("applies TUN without OS probes and does not claim network verification", async () => {
    await harness.startServer({
      tunPlatform: {
        ...unsupportedTunPlatform(),
        mechanism: "capabilities",
        inspect: async () => ({ state: "ready" }),
      },
    });
    await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: true, autoRoute: false } },
    });
    assert.equal(
      (await harness.apiRequest("/sash/core/restart", { method: "POST" })).statusCode,
      200,
    );
    const status = await tunState();
    assert.equal(status.desired, true);
    assert.equal(status.applied, true);
    assert.deepEqual((await harness.apiRequest("/sash/tun")).data, {
      state: "ready",
      mechanism: "capabilities",
      detail: null,
    });
  });

  it("refuses to Apply TUN until the helper is ready and keeps the Core running", async () => {
    await harness.startServer({
      tunPlatform: {
        ...unsupportedTunPlatform(),
        mechanism: "service",
        inspect: async () => ({
          state: "stale",
          detail: "the TUN service serves another data folder",
        }),
      },
    });
    assert.equal(
      (await harness.apiRequest("/sash/core/start", { method: "POST" })).statusCode,
      200,
    );
    await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: true } },
    });
    const applied = await harness.apiRequest("/sash/core/restart", { method: "POST" });
    assert.notEqual(applied.statusCode, 200);
    assert.match(JSON.stringify(applied.data), /Install the TUN helper again.*another data folder/);
    assert.deepEqual((await harness.apiRequest("/sash/tun")).data, {
      state: "stale",
      mechanism: "service",
      detail: "the TUN service serves another data folder",
    });
    const status = await tunState();
    assert.equal(status.applied, false);
    assert.equal(status.desired, false);
  });

  it("keeps TUN enabled but reverts its edit when a ready check fails before restart", async () => {
    let ready = true;
    const supervisor = new FakeCoreSupervisor(harness.layout, harness.settings);
    await harness.startServer({
      supervisor,
      tunPlatform: {
        ...unsupportedTunPlatform(),
        mechanism: "capabilities",
        inspect: async () => ({ state: ready ? "ready" : "stale" }),
      },
    });
    await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: true } },
    });
    assert.equal(
      (await harness.apiRequest("/sash/core/restart", { method: "POST" })).statusCode,
      200,
    );
    ready = false;
    assert.equal(
      (
        await harness.apiRequest("/sash/settings", {
          method: "PATCH",
          body: { tun: { strictRoute: true } },
        })
      ).statusCode,
      200,
    );

    const applied = await harness.apiRequest("/sash/core/restart", { method: "POST" });

    assert.notEqual(applied.statusCode, 200);
    assert.equal(supervisor.running, true);
    const status = await tunState();
    assert.equal(status.desired, true);
    assert.equal(status.applied, true);
    const daemon = (await harness.apiRequest("/sash/daemon/status")).data as DaemonStatus;
    assert.equal(daemon.settings.tun.strictRoute, false);
  });

  it("installs the helper through the platform and refuses removal while TUN runs", async () => {
    let ready = false;
    const installs: unknown[] = [];
    await harness.startServer({
      tunPlatform: {
        ...unsupportedTunPlatform(),
        mechanism: "setuid",
        inspect: async () => ({ state: ready ? "ready" : "missing" }),
        install: async (_layout, options) => {
          installs.push(options);
          ready = true;
        },
        uninstall: async () => {
          ready = false;
        },
      },
    });
    const installed = await harness.apiRequest("/sash/tun/helper/install", {
      method: "POST",
      body: { helperAuth: "sudo" },
    });
    assert.equal(installed.statusCode, 200);
    assert.equal((installed.data as TunHelperStatus).state, "ready");
    assert.deepEqual(installs, [{ helperAuth: "sudo" }]);
    assert.equal(
      (
        await harness.apiRequest("/sash/tun/helper/install", {
          method: "POST",
          body: { helperAuth: "invalid" },
        })
      ).statusCode,
      400,
    );

    await harness.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { tun: { enable: true } },
    });
    assert.equal(
      (await harness.apiRequest("/sash/core/restart", { method: "POST" })).statusCode,
      200,
    );
    assert.equal(
      (await harness.apiRequest("/sash/tun/helper/uninstall", { method: "POST" })).statusCode,
      409,
    );
    assert.equal(ready, true);
  });
});
