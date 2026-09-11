import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { AutostartUnavailableError } from "./autostart.js";
import type { AutostartStatus } from "./autostart-contract.js";
import { createDaemonClient } from "./daemon-client.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";

describe("autostart HTTP API", () => {
  const h = useDaemonTestHarness();

  it("requires control credentials for reads and writes and accepts only an explicit boolean", async () => {
    let writes = 0;
    let reads = 0;
    await h.startServer({
      autostart: {
        inspect: async () => {
          reads += 1;
          return { state: "off", canEnable: true, reason: null };
        },
        set: async () => {
          writes += 1;
          return { state: "on", canEnable: true, reason: null };
        },
      },
    });
    for (const method of ["GET", "PUT"]) {
      assert.equal(
        (
          await h.apiRequest("/sash/autostart", {
            method,
            token: "",
            body: method === "PUT" ? { enabled: true } : undefined,
          })
        ).statusCode,
        401,
      );
    }
    assert.equal(reads, 0);
    for (const body of [
      {},
      { enabled: "true" },
      { enabled: 1 },
      { enabled: null },
      { enabled: true, command: "arbitrary" },
    ]) {
      assert.equal(
        (await h.apiRequest("/sash/autostart", { method: "PUT", body })).statusCode,
        400,
      );
    }
    assert.equal(writes, 0);
    assert.equal(
      (
        await h.apiRequest("/sash/autostart", {
          method: "PUT",
          body: { enabled: true },
          origin: "https://example.test",
        })
      ).statusCode,
      403,
    );
    assert.equal(writes, 0);
  });

  it("changes the OS registration through CLI and browser clients", async (t) => {
    let enabled = false;
    const state = () => ({
      state: enabled ? ("on" as const) : ("off" as const),
      canEnable: true,
      reason: null,
    });
    const instance = await h.startServer({
      autostart: {
        inspect: async () => state(),
        set: async (next) => {
          enabled = next ?? !enabled;
          return state();
        },
      },
    });
    const starts = t.mock.method(instance.supervisor, "start");
    const stops = t.mock.method(instance.supervisor, "stop");
    const settings = fs.readFileSync(h.layout.settingsFile, "utf8");
    const client = createDaemonClient(h.boundPort, h.settings.daemonSecret);
    assert.equal((await client.autostartStatus()).state, "off");
    assert.equal((await client.setAutostart(true)).state, "on");
    const session = await h.mintWebSession();
    const response = await h.apiRequest("/sash/autostart", {
      method: "PUT",
      body: { enabled: false },
      webToken: session,
    });
    assert.equal((response.data as AutostartStatus).state, "off");
    assert.equal(starts.mock.callCount(), 0);
    assert.equal(stops.mock.callCount(), 0);
    assert.equal(fs.readFileSync(h.layout.settingsFile, "utf8"), settings);
  });

  it("reports an unsupported installation as a conflict with no success response", async () => {
    await h.startServer({
      autostart: {
        inspect: async () => ({
          state: "off",
          canEnable: false,
          reason: "Global install required",
        }),
        set: async () => {
          throw new AutostartUnavailableError("Global install required");
        },
      },
    });
    const response = await h.apiRequest("/sash/autostart", {
      method: "PUT",
      body: { enabled: true },
    });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.data, {
      error: { code: "conflict", message: "Global install required" },
    });
  });
});
