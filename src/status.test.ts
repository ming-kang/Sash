import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { withCliErrors } from "./cli-errors.js";
import { runProxyStatus } from "./commands/proxy.js";
import { runStatus } from "./commands/status.js";
import type { DaemonStatus } from "./contracts.js";
import { sashLayout } from "./paths.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import {
  collectProxyStatus,
  collectRuntimeStatus,
  formatTunObservation,
  markIncompleteObservation,
  runtimeStatusHeadline,
  type StatusObservationContext,
  type StatusObservationDependencies,
  shouldShowTunGuidance,
} from "./status.js";

const context: StatusObservationContext = {
  layout: sashLayout(path.join(os.tmpdir(), "sash-status-observation-test")),
  settings: {
    ...DEFAULT_SETTINGS,
    secret: "core-secret",
    daemonSecret: "daemon-secret",
    systemProxy: true,
    tun: true,
  },
};

function statusResponse(
  core: DaemonStatus["core"],
  options: { proxyActual?: boolean } = { proxyActual: true },
): DaemonStatus {
  return {
    daemon: { pid: 101, startedAt: "2026-01-01T00:00:00.000Z", port: 19090 },
    revisions: { profiles: 1 },
    core,
    systemProxy: {
      desired: true,
      applied: true,
      ...(options.proxyActual
        ? {
            actual: {
              supported: true,
              enabled: true,
              server: "127.0.0.1:17890",
            },
          }
        : {}),
    },
    settings: {
      mixedPort: 17890,
      controller: "127.0.0.1:9090",
      tun: true,
      allowLan: false,
      daemonPort: 19090,
      systemProxy: true,
    },
    activeProfile: null,
  };
}

function dependencies(
  overrides: StatusObservationDependencies = {},
): StatusObservationDependencies {
  return {
    evaluateDaemon: async () => ({ running: true, healthy: true, pid: 101, port: 19090 }),
    queryDaemonStatus: async () =>
      statusResponse({
        running: true,
        healthy: true,
        pid: 202,
        startedAt: "2026-01-01T00:00:01.000Z",
        version: "v1.2.3",
        tunActive: false,
      }),
    queryDaemonProxy: async () => ({
      desired: true,
      applied: true,
      supported: true,
      enabled: true,
      server: "127.0.0.1:17890",
    }),
    inspectSystemProxy: () => ({
      applied: true,
      state: { supported: true, enabled: true, server: "127.0.0.1:17890" },
    }),
    installedCoreVersion: () => "v1.2.3",
    activeProfile: () => null,
    hasUi: () => true,
    ...overrides,
  };
}

async function captureConsole(action: () => Promise<void>): Promise<{
  logs: string[];
  warnings: string[];
  errors: string[];
}> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    await action();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  return { logs, warnings, errors };
}

describe("CLI runtime status observations", () => {
  let previousExitCode: number | string | null | undefined;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  it("reports a complete healthy runtime without losing explicit TUN inactivity", async () => {
    const status = await collectRuntimeStatus(context, dependencies());

    assert.deepEqual(Object.keys(status).sort(), [
      "activeProfile",
      "complete",
      "core",
      "daemon",
      "endpoints",
      "healthy",
      "paths",
      "queryError",
      "schemaVersion",
      "systemProxy",
      "tun",
      "uiInstalled",
    ]);
    assert.deepEqual(Object.keys(status.systemProxy).sort(), [
      "daemonApplied",
      "desired",
      "osObserved",
    ]);
    assert.equal(status.schemaVersion, 1);
    assert.equal(status.complete, true);
    assert.equal(status.healthy, true);
    assert.equal(status.queryError, null);
    assert.deepEqual(status.core, {
      running: true,
      healthy: true,
      pid: 202,
      version: "v1.2.3",
      installedVersion: "v1.2.3",
    });
    assert.deepEqual(status.tun, { desired: true, active: false });
    assert.equal(formatTunObservation(status), "on (inactive)");
    assert.equal(shouldShowTunGuidance(status), true);
    assert.equal(runtimeStatusHeadline(status).level, "ok");

    await captureConsole(() => runStatus({ json: true }, async () => status));
    assert.equal(process.exitCode ?? 0, 0);
  });

  it("reports a stopped daemon as a complete known state", async () => {
    let queried = false;
    const status = await collectRuntimeStatus(
      context,
      dependencies({
        evaluateDaemon: async () => ({ running: false }),
        queryDaemonStatus: async () => {
          queried = true;
          throw new Error("must not query");
        },
        inspectSystemProxy: () => ({
          applied: false,
          state: { supported: true, enabled: false },
        }),
      }),
    );

    assert.equal(queried, false);
    assert.equal(status.complete, true);
    assert.equal(status.healthy, false);
    assert.equal(status.daemon.state, "stopped");
    assert.equal(status.core.running, false);
    assert.equal(status.core.healthy, false);
    assert.equal(status.tun.active, false);
    assert.equal(formatTunObservation(status), "on (core stopped)");
    assert.equal(shouldShowTunGuidance(status), false);
    assert.equal(runtimeStatusHeadline(status).level, "info");
  });

  it("keeps unknown fields null for an unresponsive daemon", async () => {
    const status = await collectRuntimeStatus(
      context,
      dependencies({
        evaluateDaemon: async () => ({ running: true, healthy: false, pid: 101 }),
      }),
    );

    assert.equal(status.complete, false);
    assert.equal(status.healthy, null);
    assert.match(status.queryError ?? "", /control API is unavailable/);
    assert.equal(status.daemon.state, "unhealthy");
    assert.equal(status.core.running, null);
    assert.equal(status.core.healthy, null);
    assert.equal(status.systemProxy.daemonApplied, null);
    assert.equal(formatTunObservation(status), "on (runtime unknown)");
    assert.equal(
      formatTunObservation({ ...status, tun: { desired: false, active: null } }),
      "off (runtime unknown)",
    );
    assert.equal(shouldShowTunGuidance(status), false);
    assert.equal(runtimeStatusHeadline(status).level, "warn");
  });

  it("uses null instead of false when OS proxy observation fails", async () => {
    const status = await collectRuntimeStatus(
      context,
      dependencies({
        evaluateDaemon: async () => ({ running: false }),
        inspectSystemProxy: () => ({
          applied: false,
          appliedKnown: false,
          stateKnown: false,
          queryError: "registry query failed",
          state: { supported: true, enabled: false, details: "registry query failed" },
        }),
      }),
    );

    assert.equal(status.complete, false);
    assert.match(status.queryError ?? "", /registry query failed/);
    assert.equal(status.systemProxy.osObserved.supported, null);
    assert.equal(status.systemProxy.osObserved.enabled, null);
  });

  it("converts a status timeout into incomplete output and exit code 2", async () => {
    const status = await collectRuntimeStatus(
      context,
      dependencies({
        queryDaemonStatus: async () => {
          throw new Error("HTTP request deadline exceeded after 5000ms");
        },
      }),
    );

    assert.equal(status.complete, false);
    assert.equal(status.healthy, null);
    assert.match(status.queryError ?? "", /deadline exceeded/);
    assert.equal(status.core.running, null);
    markIncompleteObservation(status.complete);
    assert.equal(process.exitCode, 2);
  });

  it("treats a reported unhealthy Core as incomplete without privilege guidance", async () => {
    const status = await collectRuntimeStatus(
      context,
      dependencies({
        queryDaemonStatus: async () =>
          statusResponse({ running: true, healthy: false, pid: 202, version: "v1.2.3" }),
      }),
    );

    assert.equal(status.complete, false);
    assert.equal(status.healthy, false);
    assert.equal(status.core.running, true);
    assert.equal(status.core.healthy, false);
    assert.match(status.queryError ?? "", /health probe failed/);
    assert.equal(shouldShowTunGuidance(status), false);
    assert.equal(runtimeStatusHeadline(status).level, "warn");
  });

  it("prints the stable JSON contract with null unknowns and no success claim", async () => {
    const timeoutStatus = await collectRuntimeStatus(
      context,
      dependencies({
        queryDaemonStatus: async () => {
          throw new Error("status timeout");
        },
      }),
    );
    const jsonOutput = await captureConsole(() =>
      runStatus({ json: true }, async () => timeoutStatus),
    );
    const parsed = JSON.parse(jsonOutput.logs.join("\n")) as Record<string, unknown>;

    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.complete, false);
    assert.equal(parsed.healthy, null);
    assert.equal((parsed.core as { running: unknown }).running, null);
    assert.equal((parsed.systemProxy as { daemonApplied: unknown }).daemonApplied, null);
    assert.equal((parsed.tun as { active: unknown }).active, null);
    assert.equal(process.exitCode, 2);

    process.exitCode = undefined;
    const textOutput = await captureConsole(() => runStatus({}, async () => timeoutStatus));
    assert.equal(
      textOutput.logs.some((line) => line.includes("✓")),
      false,
    );
    assert.equal(
      textOutput.warnings.some((line) => line.includes("runtime status is unavailable")),
      true,
    );
    assert.equal(
      textOutput.warnings.some((line) => line.includes("status incomplete")),
      true,
    );
    assert.equal(process.exitCode, 2);
  });

  it("preserves exit code 1 for command failures", async () => {
    const command = withCliErrors(() =>
      runStatus({}, async () => {
        throw new Error("settings are corrupt");
      }),
    );
    const output = await captureConsole(command);

    assert.equal(process.exitCode, 1);
    assert.equal(
      output.errors.some((line) => line.includes("settings are corrupt")),
      true,
    );
  });
});

describe("CLI proxy status observations", () => {
  let previousExitCode: number | string | null | undefined;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  it("separates desired, daemon-applied and OS-observed values", async () => {
    const status = await collectProxyStatus(context, dependencies());

    assert.equal(status.complete, true);
    assert.equal(status.daemon.state, "healthy");
    assert.equal(status.desired, true);
    assert.equal(status.daemonApplied, true);
    assert.equal(status.osObserved.enabled, true);
  });

  it("distinguishes stopped and unhealthy daemon states", async () => {
    const stopped = await collectProxyStatus(
      context,
      dependencies({
        evaluateDaemon: async () => ({ running: false }),
        inspectSystemProxy: () => ({
          applied: false,
          state: { supported: true, enabled: false },
        }),
      }),
    );
    assert.equal(stopped.complete, true);
    assert.equal(stopped.daemon.state, "stopped");
    assert.equal(stopped.daemonApplied, false);

    const unhealthy = await collectProxyStatus(
      context,
      dependencies({
        evaluateDaemon: async () => ({ running: true, healthy: false, pid: 101 }),
      }),
    );
    assert.equal(unhealthy.complete, false);
    assert.equal(unhealthy.daemon.state, "unhealthy");
    assert.equal(unhealthy.daemonApplied, null);

    const output = await captureConsole(() => runProxyStatus(async () => unhealthy));
    assert.equal(
      output.logs.some((line) => line.includes("daemon state") && line.includes("unhealthy")),
      true,
    );
    assert.equal(
      output.logs.some((line) => line.includes("daemon-applied") && line.includes("unknown")),
      true,
    );
    assert.equal(
      output.logs.some((line) => line.includes("os-observed") && line.includes("on")),
      true,
    );
    assert.equal(process.exitCode, 2);
  });
});
