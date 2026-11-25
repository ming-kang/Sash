import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "vitest";
import YAML from "yaml";
import type { TunStatusResponse } from "./contracts.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";
import { FakeCoreSupervisor } from "./testing/state.js";
import { unsupportedTunPlatform } from "./tun-service.js";

describe("daemon TUN controls", () => {
  const harness = useDaemonTestHarness();

  it("reports unsupported and refuses helper installation on an unsupported platform", async () => {
    await harness.startServer({ tunPlatform: unsupportedTunPlatform() });
    const status = await harness.apiRequest("/sash/tun");
    assert.equal(status.statusCode, 200);
    assert.equal((status.data as TunStatusResponse).supported, false);
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
    const pending = (await harness.apiRequest("/sash/tun")).data as TunStatusResponse;
    assert.equal(pending.desired, true);
    assert.equal(pending.applied, false);
    assert.equal(supervisor.starts, 1);
    const applied = await harness.apiRequest("/sash/core/restart", { method: "POST" });
    assert.notEqual(applied.statusCode, 200);
    const rolledBack = (await harness.apiRequest("/sash/tun")).data as TunStatusResponse;
    assert.equal(rolledBack.desired, false);
    assert.equal(rolledBack.applied, false);
    assert.equal(supervisor.running, true);
    assert.equal(YAML.parse(fs.readFileSync(harness.layout.configFile, "utf8")).tun.enable, false);
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
    const status = (await harness.apiRequest("/sash/tun")).data as TunStatusResponse;
    assert.equal(status.desired, true);
    assert.equal(status.applied, true);
    assert.equal("observed" in status, false);
    assert.equal("unverifiedChecks" in status, false);
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
    const status = (await harness.apiRequest("/sash/tun")).data as TunStatusResponse;
    assert.deepEqual(status.privilege, {
      mechanism: "service",
      state: "stale",
      detail: "the TUN service serves another data folder",
    });
    assert.equal(status.applied, false);
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
    assert.equal((installed.data as TunStatusResponse).privilege.state, "ready");
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
