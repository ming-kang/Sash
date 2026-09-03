import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type SashLayout, sashLayout } from "./paths.js";
import { reconcileOrphanedRuntime } from "./runtime-recovery.js";
import { DEFAULT_SETTINGS, type SashSettings } from "./settings.js";

describe("orphaned runtime recovery", () => {
  let root: string;
  let layout: SashLayout;
  let settings: SashSettings;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-runtime-recovery-test-"));
    layout = sashLayout(root);
    settings = {
      ...DEFAULT_SETTINGS,
      systemProxy: true,
      mixedPort: 17891,
      secret: "core-secret",
      daemonSecret: "daemon-secret",
    };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses the fixed legacy, proxy, Core, transaction, and controller order", async () => {
    const events: string[] = [];

    await reconcileOrphanedRuntime(
      {
        layout,
        settings,
        legacyDaemon: true,
        verifyControllerVacant: true,
      },
      {
        disableLegacyProxy: async ({ port }) => {
          events.push(`legacy:${port}`);
          return true;
        },
        systemProxy: {
          release: async () => {
            events.push("proxy:release");
          },
        },
        supervisor: {
          cleanStaleCore: async () => {
            events.push("core:clean");
          },
        },
        recoverCoreUpdate: () => {
          events.push("update:recover");
          return undefined;
        },
        controllerReachable: async (current) => {
          events.push(`controller:${current.controller}`);
          return false;
        },
      },
    );

    assert.deepEqual(events, [
      `legacy:${settings.mixedPort}`,
      "proxy:release",
      "core:clean",
      "update:recover",
      `controller:${settings.controller}`,
    ]);
  });

  it("skips legacy cleanup unless legacy ownership and desired proxy are both present", async () => {
    const events: string[] = [];
    await reconcileOrphanedRuntime(
      { layout, settings: { ...settings, systemProxy: false }, legacyDaemon: true },
      {
        disableLegacyProxy: async () => {
          events.push("legacy");
          return true;
        },
        systemProxy: {
          release: async () => {
            events.push("proxy");
          },
        },
        supervisor: {
          cleanStaleCore: async () => {
            events.push("core");
          },
        },
        recoverCoreUpdate: () => {
          events.push("update");
          return undefined;
        },
      },
    );

    assert.deepEqual(events, ["proxy", "core", "update"]);
  });

  it("fails closed when an unowned controller remains reachable after cleanup", async () => {
    const events: string[] = [];

    await assert.rejects(
      () =>
        reconcileOrphanedRuntime(
          { layout, settings, verifyControllerVacant: true },
          {
            systemProxy: {
              release: async () => {
                events.push("proxy");
              },
            },
            supervisor: {
              cleanStaleCore: async () => {
                events.push("core");
              },
            },
            recoverCoreUpdate: () => {
              events.push("update");
              return undefined;
            },
            controllerReachable: async () => {
              events.push("controller");
              return true;
            },
          },
        ),
      /Core controller is active without a live Sash PID owner/,
    );

    assert.deepEqual(events, ["proxy", "core", "update", "controller"]);
  });

  it("does not terminate a stale Core when proxy restoration fails", async () => {
    let coreCleaned = false;

    await assert.rejects(
      () =>
        reconcileOrphanedRuntime(
          { layout, settings },
          {
            systemProxy: {
              release: async () => {
                throw new Error("proxy restore failed");
              },
            },
            supervisor: {
              cleanStaleCore: async () => {
                coreCleaned = true;
              },
            },
          },
        ),
      /proxy restore failed/,
    );

    assert.equal(coreCleaned, false);
  });
});
