import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { testAutostartContext } from "../testing/autostart-context.js";
import {
  type FakeWindowsRegistration,
  fakeWindowsRegistryRun,
} from "../testing/windows-registry.js";
import type { RegisteredAutostartState } from "./contract.js";
import { AutostartService } from "./service.js";

describe("AutostartService", () => {
  it("reports a stale login startup when the Node path changed", async (t) => {
    const registration: FakeWindowsRegistration = { command: null, approval: null };
    let _writes = 0;
    const { root, options } = testAutostartContext(
      t,
      "win32",
      fakeWindowsRegistryRun(registration, () => {
        _writes += 1;
      }),
    );
    const node = path.join(root, "new-node.exe");
    fs.writeFileSync(node, "fixture Node path");
    const original = new AutostartService({ ...options, checkInstallation: () => null });
    const replacement = new AutostartService({
      ...options,
      nodePath: node,
      checkInstallation: () => null,
    });
    await original.set(true);
    assert.equal((await replacement.inspect()).state, "stale");
    // Enabling again rewrites the registration for the current Node path.
    assert.equal((await replacement.set(true)).state, "on");
    assert.equal((await replacement.inspect()).state, "on");
    const reloadedOriginal = new AutostartService({ ...options, checkInstallation: () => null });
    assert.equal((await reloadedOriginal.inspect()).state, "stale");
  });

  it("serves cached status within TTL without re-invoking backend and refreshes cache on set", async (t) => {
    const { options } = testAutostartContext(t, "win32");
    let state: RegisteredAutostartState = "off";
    let backendInspectCalls = 0;
    const backend = {
      inspect: async () => {
        backendInspectCalls++;
        return state;
      },
      set: async (enabled: boolean) => {
        state = enabled ? "on" : "off";
      },
    };
    const service = new AutostartService({ ...options, backend, checkInstallation: () => null });

    // Initial inspect calls backend
    const first = await service.inspect();
    assert.equal(first.state, "off");
    assert.equal(backendInspectCalls, 1);

    // Second inspect within TTL reuses cache without calling backend
    const second = await service.inspect();
    assert.equal(second.state, "off");
    assert.equal(backendInspectCalls, 1);

    // set(true) refreshes cache immediately
    const setResult = await service.set(true);
    assert.equal(setResult.state, "on");
    assert.equal(backendInspectCalls, 2);

    // inspect() after set(true) serves newly populated cache without re-invoking backend
    const third = await service.inspect();
    assert.equal(third.state, "on");
    assert.equal(backendInspectCalls, 2);

    // set(false) updates cache to off
    const unsetResult = await service.set(false);
    assert.equal(unsetResult.state, "off");

    // inspect() after set(false) serves cached "off" without calling backend
    const fourth = await service.inspect();
    assert.equal(fourth.state, "off");
    assert.equal(backendInspectCalls, 2);
  });

  it("does not cache a pre-mutation inspection that settles after set()", async (t) => {
    const { options } = testAutostartContext(t, "win32");
    let state: RegisteredAutostartState = "off";
    let inspectCalls = 0;
    let releaseFirst!: () => void;
    const backend = {
      inspect: () => {
        inspectCalls++;
        // Like a real registry query, the value is captured when the call starts.
        const observed = state;
        if (inspectCalls === 1) {
          return new Promise<RegisteredAutostartState>((resolve) => {
            releaseFirst = () => resolve(observed);
          });
        }
        return Promise.resolve(observed);
      },
      set: async (enabled: boolean) => {
        state = enabled ? "on" : "off";
      },
    };
    const service = new AutostartService({ ...options, backend, checkInstallation: () => null });

    // An inspection begins and stays in flight while the mutation lands.
    const slowInspect = service.inspect();
    assert.equal((await service.set(true)).state, "on");
    assert.equal(inspectCalls, 2);

    // The pre-mutation inspection settles late: its caller keeps the honest old
    // observation, but it must not overwrite the cache set() populated.
    releaseFirst();
    assert.equal((await slowInspect).state, "off");
    const after = await service.inspect();
    assert.equal(after.state, "on");
    assert.equal(inspectCalls, 2);
  });
  it("enables and repairs registrations using the explicit target state", async (t) => {
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
      const result = await service.set(initial !== "on");
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
    await assert.rejects(service.set(true), /Source checkouts/);
    assert.equal((await service.set(false)).state, "off");
    assert.equal(disabled, true);
  });

  it("serializes writes across controllers sharing the same OS user", async (t) => {
    const { options } = testAutostartContext(t, "win32");
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
    await Promise.all([first.set(true), second.set(false)]);
    assert.deepEqual(writes, [true, false]);
    assert.equal(state, "off");
  });

  it("does not claim success when the OS ignores a registration", async (t) => {
    const { options } = testAutostartContext(t, "win32");
    const service = new AutostartService({
      ...options,
      checkInstallation: () => null,
      backend: { inspect: async () => "disabled", set: async () => {} },
    });
    await assert.rejects(service.set(true), /Could not verify autostart: disabled/);
  });

  it("reports unsupported systems without invoking any OS helper", async (t) => {
    for (const platform of ["darwin", "linux", "freebsd"] as const) {
      const { options } = testAutostartContext(t, platform);
      const service = new AutostartService(options);
      assert.equal((await service.inspect()).state, "unsupported");
      await assert.rejects(service.set(true), /not supported/);
    }
  });
});
