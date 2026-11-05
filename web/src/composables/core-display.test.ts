import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { nextTick } from "vue";
import { testStatus } from "../../../src/testing/state.js";
import { markDaemonOffline } from "../stores/runtime-actions.js";
import { adoptDaemonStatus } from "../stores/state.js";
import type { SashStatus } from "../types/index.js";
import { coreDisplayState, useCoreDisplay } from "./core-display.js";

function withCore(core: SashStatus["core"], patch: Partial<SashStatus> = {}): SashStatus {
  return { ...testStatus(), ...patch, core };
}

describe("coreDisplayState", () => {
  const base = { starting: false, stopping: false };

  it("separates a responding Core from one whose controller is silent", () => {
    assert.equal(coreDisplayState({ ...base, status: testStatus() }), "running");
    assert.equal(
      coreDisplayState({ ...base, status: withCore({ running: true, healthy: false }) }),
      "unresponsive",
    );
    assert.equal(coreDisplayState({ ...base, status: withCore({ running: false }) }), "stopped");
  });

  it("shows transitions in progress", () => {
    const stopped = withCore({ running: false });
    assert.equal(coreDisplayState({ ...base, status: stopped, starting: true }), "starting");
    // A reload of a running Core keeps reporting its running state.
    assert.equal(coreDisplayState({ ...base, status: testStatus(), starting: true }), "running");
    assert.equal(coreDisplayState({ ...base, status: testStatus(), stopping: true }), "stopping");
  });
});

describe("useCoreDisplay", () => {
  afterEach(() => markDaemonOffline());

  it("follows the store across a stop and a start", async () => {
    const display = useCoreDisplay();
    adoptDaemonStatus(testStatus());
    await nextTick();
    assert.equal(display.state.value, "running");

    adoptDaemonStatus(withCore({ running: false }));
    await nextTick();
    assert.equal(display.state.value, "stopped");

    adoptDaemonStatus(testStatus());
    await nextTick();
    assert.equal(display.state.value, "running");
  });
});
