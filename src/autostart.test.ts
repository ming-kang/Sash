import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { testAutostartContext } from "./autostart/test-context.test.js";
import { AutostartService } from "./autostart.js";
import type { RegisteredAutostartState } from "./autostart-contract.js";

describe("AutostartService", () => {
  it("repairs stale and OS-disabled registrations and toggles only an effective entry off", async (t) => {
    const { options, ctx } = testAutostartContext(t, "win32");
    let state: RegisteredAutostartState = "off";
    const writes: boolean[] = [];
    const service = new AutostartService({
      ...options,
      checkInstallation: () => null,
      backend: {
        inspect: async () => state,
        set: async (enabled) => {
          writes.push(enabled);
          state = enabled ? "on" : "off";
        },
      },
    });
    assert.deepEqual(await service.inspect(), { state: "off", canEnable: true, reason: null });
    assert.equal(fs.existsSync(ctx.controlDir), false, "inspection must not write state");
    for (const initial of ["off", "stale", "disabled", "on"] as const) {
      state = initial;
      const result = await service.set();
      assert.equal(result.state, initial === "on" ? "off" : "on");
    }
    assert.deepEqual(writes, [true, true, true, false]);
  });

  it("allows deterministic removal when inspection or installation validation is unavailable", async (t) => {
    const { options } = testAutostartContext(t, "win32");
    let disabled = false;
    const service = new AutostartService({
      ...options,
      checkInstallation: () => "Source checkouts cannot register startup",
      backend: {
        inspect: async () => {
          throw new Error("registry denied");
        },
        set: async (enabled) => {
          assert.equal(enabled, false);
          disabled = true;
        },
      },
    });
    assert.equal((await service.inspect()).state, "unknown");
    await assert.rejects(service.set(), /registry denied/);
    await assert.rejects(service.set(true), /Source checkouts/);
    assert.equal((await service.set(false)).state, "off");
    assert.equal(disabled, true);
  });

  it("serializes toggles across controllers sharing the same OS user", async (t) => {
    const { options } = testAutostartContext(t, "linux");
    let state: RegisteredAutostartState = "off";
    const writes: boolean[] = [];
    const backend = {
      inspect: async () => state,
      set: async (enabled: boolean) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        writes.push(enabled);
        state = enabled ? "on" : "off";
      },
    };
    const first = new AutostartService({ ...options, backend, checkInstallation: () => null });
    const second = new AutostartService({ ...options, backend, checkInstallation: () => null });
    await Promise.all([first.set(), second.set()]);
    assert.deepEqual(writes, [true, false]);
    assert.equal(state, "off");
  });

  it("does not claim success when the OS ignores a registration", async (t) => {
    const { options } = testAutostartContext(t, "linux");
    const service = new AutostartService({
      ...options,
      checkInstallation: () => null,
      backend: { inspect: async () => "disabled", set: async () => {} },
    });
    await assert.rejects(service.set(true), /Could not verify autostart: disabled/);
  });

  it("reports unsupported systems without invoking any OS helper", async (t) => {
    const { options } = testAutostartContext(t, "freebsd");
    const service = new AutostartService(options);
    assert.equal((await service.inspect()).state, "unsupported");
    await assert.rejects(service.set(true), /not supported/);
  });
});
