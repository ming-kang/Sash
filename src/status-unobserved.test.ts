import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { sashLayout } from "./paths.js";
import { DEFAULT_SETTINGS, publicSettings } from "./settings.js";
import { collectRuntimeStatus, formatTunObservation, markIncompleteObservation } from "./status.js";

it("reports unobserved service Core without invalidating daemon health", async () => {
  const settings = { ...DEFAULT_SETTINGS, tun: true };
  const queryError = "Sash Service Core state could not be verified";
  const status = await collectRuntimeStatus(
    { layout: sashLayout(path.join(os.tmpdir(), "sash-unobserved-test")), settings },
    {
      evaluateDaemon: async () => ({
        kind: "healthy",
        running: true,
        healthy: true,
        pid: 101,
        port: 19090,
      }),
      queryDaemonStatus: async () => ({
        daemon: { pid: 101, port: 19090, startedAt: "2026-01-01T00:00:00.000Z" },
        revisions: { profiles: 0 },
        core: { running: null, healthy: false, queryError },
        systemProxy: {
          desired: false,
          applied: false,
          appliedKnown: true,
          stateKnown: true,
          actual: { supported: true, enabled: false },
        },
        settings: publicSettings(settings),
        activeProfile: null,
      }),
      nativeServiceStatus: async () => ({ supported: false }),
      installedCoreVersion: () => "",
      activeProfile: () => null,
      hasUi: () => true,
      inspectSystemProxy: async () => {
        throw new Error("unexpected OS query");
      },
    },
  );
  assert.equal(status.daemon.healthy, true);
  assert.equal(status.daemon.state, "healthy");
  assert.equal(status.core.running, null);
  assert.equal(status.core.pid, null);
  assert.equal(status.healthy, null);
  assert.equal(status.complete, false);
  assert.equal(status.queryError, queryError);
  assert.equal(formatTunObservation(status), "on (runtime unknown)");
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    markIncompleteObservation(status.complete);
    assert.equal(process.exitCode, 2);
  } finally {
    process.exitCode = previous;
  }
});
