import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { sashLayout } from "../paths.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import type { RuntimeContext } from "./shared.js";
import { prepareUpdateMaintenance } from "./update.js";

let root: string | undefined;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("update maintenance snapshot", () => {
  it("uses the atomic shutdown result without taking a stale status snapshot", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-update-maintenance-test-"));
    const ctx: RuntimeContext = {
      layout: sashLayout(root),
      settings: {
        ...DEFAULT_SETTINGS,
        daemonPort: 19191,
        secret: "core-secret",
        daemonSecret: "daemon-secret",
      },
    };
    let statusCalls = 0;
    let maintenanceCalls = 0;
    let waitedFor: number | undefined;
    const client = {
      status: async () => {
        statusCalls++;
        return { core: { running: false } };
      },
      maintenanceShutdown: async () => {
        maintenanceCalls++;
        return { ok: true as const, coreWasRunning: true };
      },
      startCore: async () => ({ pid: 99 }),
    };

    const snapshot = await prepareUpdateMaintenance(ctx, {
      evaluateDaemon: async () => ({ running: true, healthy: true, pid: 4321 }),
      clientFactory: () => client,
      waitForDaemonExit: async (pid) => {
        waitedFor = pid;
      },
    });

    assert.deepEqual(snapshot, {
      daemonWasRunning: true,
      legacyDaemon: false,
      coreWasRunning: true,
    });
    assert.equal(maintenanceCalls, 1);
    assert.equal(statusCalls, 0);
    assert.equal(waitedFor, 4321);
  });

  it("preserves the legacy daemon compatibility path", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-update-legacy-test-"));
    const ctx: RuntimeContext = {
      layout: sashLayout(root),
      settings: {
        ...DEFAULT_SETTINGS,
        secret: "core-secret",
        daemonSecret: "daemon-secret",
      },
    };
    let maintenanceCalls = 0;
    let shutdownCalls = 0;

    const snapshot = await prepareUpdateMaintenance(ctx, {
      evaluateDaemon: async () => ({
        running: true,
        healthy: true,
        legacyOwnership: true,
        pid: 4321,
      }),
      clientFactory: () => ({
        status: async () => ({ core: { running: true } }),
        shutdown: async () => {
          shutdownCalls++;
        },
        maintenanceShutdown: async () => {
          maintenanceCalls++;
          return { ok: true as const, coreWasRunning: false };
        },
        startCore: async () => ({ pid: 99 }),
      }),
      waitForDaemonExit: async () => {},
    });

    assert.deepEqual(snapshot, {
      daemonWasRunning: true,
      legacyDaemon: true,
      coreWasRunning: true,
    });
    assert.equal(shutdownCalls, 1);
    assert.equal(maintenanceCalls, 0);
  });

  it("preserves the offline path without contacting a daemon", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-update-offline-test-"));
    const ctx: RuntimeContext = {
      layout: sashLayout(root),
      settings: {
        ...DEFAULT_SETTINGS,
        secret: "core-secret",
        daemonSecret: "daemon-secret",
      },
    };
    let clients = 0;

    const snapshot = await prepareUpdateMaintenance(ctx, {
      evaluateDaemon: async () => ({ running: false }),
      clientFactory: () => {
        clients++;
        throw new Error("client should not be created");
      },
    });

    assert.deepEqual(snapshot, {
      daemonWasRunning: false,
      legacyDaemon: false,
      coreWasRunning: false,
    });
    assert.equal(clients, 0);
  });
});
