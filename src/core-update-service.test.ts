import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { currentCoreVersion, writeInstallRecord } from "./core.js";
import { readCoreUpdateTransaction } from "./core-update.js";
import { runCoreUpdate } from "./core-update-service.js";
import { readManagedStateTransactionStatus } from "./managed-state-transaction.js";
import type { RuntimeContext } from "./offline-mutation.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings.js";

describe("Core update service", () => {
  let root: string;
  let layout: SashLayout;
  let ctx: RuntimeContext;
  let stageSequence: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-core-update-service-test-"));
    layout = sashLayout(root);
    saveSettings(
      {
        ...DEFAULT_SETTINGS,
        secret: "core-secret",
        daemonSecret: "daemon-secret",
      },
      layout,
    );
    ctx = { layout, settings: loadSettings(layout) };
    stageSequence = 0;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function verify(exe: string, expectedVersion: string): void {
    if (fs.readFileSync(exe, "utf8") !== `${expectedVersion}-core`) {
      throw new Error("version mismatch");
    }
  }

  async function stage(
    events: string[],
    version: string,
  ): Promise<{ version: string; exe: string }> {
    assert.equal(fs.existsSync(layout.runtimeOperationLockFile), false);
    events.push("stage");
    fs.mkdirSync(layout.binDir, { recursive: true });
    const exe = path.join(layout.binDir, `staged-${version}-${stageSequence++}`);
    fs.writeFileSync(exe, `${version}-core`);
    return { version, exe };
  }

  function lockedEvent(events: string[], event: string): void {
    assert.equal(fs.existsSync(layout.runtimeOperationLockFile), true, event);
    events.push(event);
  }

  it("stages outside runtime ownership and keeps maintenance through publication inside it", async () => {
    const events: string[] = [];

    await runCoreUpdate(
      ctx,
      { version: "v2" },
      {
        stageCore: async (options) => stage(events, options?.tag ?? "v2"),
        verifyExecutable: verify,
        validateConfigText: async () => {
          lockedEvent(events, "validate:text");
        },
        validateConfigFile: async () => {
          lockedEvent(events, "validate:file");
        },
        evaluateDaemon: async () => {
          lockedEvent(events, "maintenance");
          return { kind: "stopped", running: false, healthy: false };
        },
        runtimeRecovery: {
          systemProxy: {
            release: async () => {
              lockedEvent(events, "proxy:release");
            },
          },
          supervisor: {
            cleanStaleCore: async () => {
              lockedEvent(events, "core:clean");
            },
          },
          recoverCoreUpdate: () => {
            lockedEvent(events, "update:recover");
            return undefined;
          },
          controllerReachable: async () => {
            lockedEvent(events, "controller:probe");
            return false;
          },
        },
      },
    );

    assert.deepEqual(events, [
      "stage",
      "maintenance",
      "proxy:release",
      "core:clean",
      "update:recover",
      "controller:probe",
      "validate:text",
      "controller:probe",
      "validate:file",
    ]);
    assert.equal(fs.existsSync(layout.runtimeOperationLockFile), false);
    assert.equal(readCoreUpdateTransaction(layout)?.phase, "swapped");
    assert.equal(readManagedStateTransactionStatus(layout)?.phase, "retained");
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
  });

  it("reloads final settings and uses the healthy daemon port during restoration", async () => {
    fs.mkdirSync(layout.binDir, { recursive: true });
    fs.writeFileSync(layout.coreExe, "v1-core");
    writeInstallRecord({ coreVersion: "v1", installedAt: "2026-01-01T00:00:00.000Z" }, layout);
    const events: string[] = [];
    let daemonEvaluations = 0;
    let clientCreations = 0;
    let restorationPort: number | undefined;
    let restorationSecret: string | undefined;
    let restorationSettingsSecret: string | undefined;

    await runCoreUpdate(
      ctx,
      { version: "v2" },
      {
        stageCore: async (options) => stage(events, options?.tag ?? "v2"),
        verifyExecutable: verify,
        validateConfigText: async () => {},
        validateConfigFile: async () => {},
        runtimeRecovery: {
          systemProxy: { release: async () => {} },
          supervisor: { cleanStaleCore: async () => {} },
          recoverCoreUpdate: () => undefined,
          controllerReachable: async () => false,
        },
        createVerificationSupervisor: () => ({
          start: async () => ({ pid: 7001 }),
          stop: async () => {},
        }),
        evaluateDaemon: async (_layout, settings) => {
          daemonEvaluations += 1;
          if (daemonEvaluations === 1) {
            return {
              kind: "healthy",
              running: true,
              healthy: true,
              pid: 6001,
              port: 19191,
            };
          }
          restorationSettingsSecret = settings.daemonSecret;
          return {
            kind: "healthy",
            running: true,
            healthy: true,
            pid: 6002,
            port: 20202,
          };
        },
        clientFactory: (port, secret) => {
          clientCreations += 1;
          if (clientCreations === 1) {
            assert.equal(port, 19191);
            return {
              maintenanceShutdown: async () => ({ ok: true, coreWasRunning: true }),
              startCore: async () => ({ pid: 7002 }),
            };
          }
          restorationPort = port;
          restorationSecret = secret;
          return {
            maintenanceShutdown: async () => ({ ok: true, coreWasRunning: false }),
            startCore: async () => ({ pid: 7003 }),
          };
        },
        waitForDaemonExit: async () => {},
        ensureDaemon: async () => {
          saveSettings(
            {
              ...loadSettings(layout),
              daemonPort: 20201,
              daemonSecret: "final-daemon-secret",
            },
            layout,
          );
        },
      },
    );

    assert.equal(restorationPort, 20202);
    assert.equal(restorationSecret, "final-daemon-secret");
    assert.equal(restorationSettingsSecret, "final-daemon-secret");
    assert.equal(currentCoreVersion(layout), "v2");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
    assert.equal(readManagedStateTransactionStatus(layout), undefined);
  });

  it("reports failed update recovery even when no daemon needs restoration", async () => {
    const events: string[] = [];
    let releaseCalls = 0;

    await assert.rejects(
      () =>
        runCoreUpdate(
          ctx,
          { version: "v2" },
          {
            stageCore: async (options) => stage(events, options?.tag ?? "v2"),
            verifyExecutable: verify,
            validateConfigText: async () => {},
            validateConfigFile: async () => {
              throw new Error("config validation failed");
            },
            evaluateDaemon: async () => ({
              kind: "stopped",
              running: false,
              healthy: false,
            }),
            runtimeRecovery: {
              systemProxy: {
                release: async () => {
                  releaseCalls += 1;
                  if (releaseCalls > 1) throw new Error("recovery blocked");
                },
              },
              supervisor: { cleanStaleCore: async () => {} },
              recoverCoreUpdate: () => undefined,
              controllerReachable: async () => false,
            },
          },
        ),
      /config validation failed; update recovery failed: recovery blocked/,
    );

    assert.equal(releaseCalls, 2);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
    assert.equal(readManagedStateTransactionStatus(layout), undefined);
  });
});
