import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { nextTick } from "vue";
import { testStatus } from "../../../src/testing/state.js";
import { markDaemonOffline } from "../stores/runtime-actions.js";
import { adoptDaemonStatus } from "../stores/state.js";
import type { SashStatus } from "../types/index.js";
import { coreDisplayState, rememberCoreVersion, useCoreDisplay } from "./core-display.js";

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

describe("rememberCoreVersion", () => {
  it("keeps the last reported version while Core cannot report one", () => {
    assert.equal(rememberCoreVersion("", testStatus()), "v1.0.0");
    assert.equal(
      rememberCoreVersion("", withCore({ running: true, version: "1.19.2" })),
      "v1.19.2",
    );
    assert.equal(rememberCoreVersion("v1.0.0", withCore({ running: false })), "v1.0.0");
    assert.equal(rememberCoreVersion("v1.0.0", null), "v1.0.0");
  });

  it("forgets the version once an update starts replacing the binary", () => {
    const updating = withCore(
      { running: false },
      {
        coreUpdate: {
          stage: "downloading",
          startedAt: "2026-11-05T00:00:00.000Z",
          target: "v2.0.0",
          downloading: true,
          downloaded: 0,
          total: null,
        },
      },
    );
    assert.equal(rememberCoreVersion("v1.0.0", updating), "");
  });
});

describe("useCoreDisplay", () => {
  afterEach(() => markDaemonOffline());

  it("follows the store across a stop and a start", async () => {
    const display = useCoreDisplay();
    adoptDaemonStatus(testStatus());
    await nextTick();
    assert.equal(display.state.value, "running");
    assert.equal(display.version.value, "v1.0.0");

    adoptDaemonStatus(withCore({ running: false }));
    await nextTick();
    assert.equal(display.state.value, "stopped");
    assert.equal(display.version.value, "v1.0.0");

    adoptDaemonStatus(testStatus());
    await nextTick();
    assert.equal(display.state.value, "running");
  });
});
