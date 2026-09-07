import type { CoreStartResult } from "./contracts.js";
import { assertCoreInstallationConsistent, coreInstalled, installCore } from "./core.js";
import { recoverCoreInstallTransaction } from "./core-install-transaction.js";
import { recoverCoordinatedCoreUpdate } from "./core-update-coordination.js";
import { SashDaemonClient } from "./daemon-client.js";
import {
  type DaemonHealthyInfo,
  type DaemonMaintenanceDeps,
  type DaemonStoppedInfo,
  type DaemonUnhealthyInfo,
  ensureDaemon,
  evaluateDaemon,
  prepareDaemonMaintenance,
  spawnDaemon,
  stopDaemonFromCli,
} from "./daemon-lifecycle.js";
import { log } from "./log.js";
import { type RuntimeContext, runOfflineMutation } from "./offline-mutation.js";
import { withStateLock } from "./state-lock.js";

/**
 * Runtime ownership state machine: decide whether the daemon owns the Core,
 * and orchestrate start/stop/restart sequences. CLI commands consume these
 * functions and own only argument parsing and output formatting.
 */

export type CommandRuntimeOwner =
  | { kind: "daemon"; daemon: DaemonHealthyInfo; client: SashDaemonClient }
  | { kind: "offline"; daemon: DaemonStoppedInfo }
  | { kind: "unhealthy"; daemon: DaemonUnhealthyInfo };

export type HealthyRuntimeOwner = Extract<CommandRuntimeOwner, { kind: "daemon" }>;

export interface RuntimeOwnerDependencies {
  evaluateDaemon?: typeof evaluateDaemon;
  clientFactory?: (port: number, secret: string) => SashDaemonClient;
}

export async function resolveRuntimeOwner(
  ctx: RuntimeContext,
  dependencies: RuntimeOwnerDependencies = {},
): Promise<CommandRuntimeOwner> {
  const daemon = await (dependencies.evaluateDaemon ?? evaluateDaemon)(ctx.layout, ctx.settings);
  if (daemon.kind === "healthy") {
    const client = (
      dependencies.clientFactory ?? ((port, secret) => new SashDaemonClient(port, secret))
    )(daemon.port, ctx.settings.daemonSecret);
    return { kind: "daemon", daemon, client };
  }
  return daemon.kind === "stopped" ? { kind: "offline", daemon } : { kind: "unhealthy", daemon };
}

/** Install the Core when missing; refuse to touch an ambiguous binary. */
export async function ensureCore(ctx: RuntimeContext): Promise<void> {
  recoverCoreInstallTransaction(ctx.layout);
  recoverCoordinatedCoreUpdate(ctx.layout);
  assertCoreInstallationConsistent(ctx.layout);
  if (coreInstalled(ctx.layout)) return;
  log.info("mihomo core not installed; downloading latest release...");
  const { version } = await installCore({ layout: ctx.layout });
  log.ok(`mihomo core ${version} installed`);
}

function withRuntimeOperation<T>(
  ctx: RuntimeContext,
  purpose: string,
  action: () => T | Promise<T>,
): Promise<T> {
  return withStateLock(ctx.layout.runtimeOperationLockFile, { purpose, timeoutMs: 120_000 }, () =>
    action(),
  );
}

async function healthyDaemonOwner(ctx: RuntimeContext): Promise<HealthyRuntimeOwner> {
  const owner = await resolveRuntimeOwner(ctx);
  if (owner.kind !== "daemon") {
    throw new Error("sashd did not become healthy after startup");
  }
  return owner;
}

export interface RunningRuntime {
  owner: HealthyRuntimeOwner;
  result: CoreStartResult;
}

/** Ensure sashd is up and the Core is running; refuse to race a sick daemon. */
export async function ensureRunning(ctx: RuntimeContext): Promise<RunningRuntime> {
  return withRuntimeOperation(ctx, "start runtime", async () => {
    const initialOwner = await resolveRuntimeOwner(ctx);
    if (initialOwner.kind === "unhealthy") {
      throw new Error("sashd is already starting or unresponsive; refusing a competing start");
    }
    if (initialOwner.kind === "offline") {
      await runOfflineMutation(ctx, "install Core before start", () => ensureCore(ctx));
    }

    await ensureDaemon({ layout: ctx.layout, settings: ctx.settings });
    const owner = await healthyDaemonOwner(ctx);
    const result = await owner.client.startCore();
    return { owner, result };
  });
}

export interface StoppedRuntime {
  wasRunning: boolean;
  legacyDaemon: boolean;
}

/** Stop the daemon through its maintenance boundary, then reconcile leftovers. */
export async function stopRuntime(ctx: RuntimeContext): Promise<StoppedRuntime> {
  return withRuntimeOperation(ctx, "stop runtime", async () => {
    const owner = await resolveRuntimeOwner(ctx);
    if (owner.kind !== "offline") {
      const stopped = await stopDaemonFromCli({ layout: ctx.layout, settings: ctx.settings });
      if (!stopped) throw new Error("sashd could not be stopped safely");
    }

    await runOfflineMutation(ctx, "finalize stopped runtime", () => undefined, {
      reconcileRuntime: {
        ...(owner.kind !== "offline" && owner.daemon.legacyOwnership ? { legacyDaemon: true } : {}),
      },
    });

    return {
      wasRunning: owner.kind !== "offline",
      legacyDaemon: owner.kind !== "offline" && owner.daemon.legacyOwnership === true,
    };
  });
}

export interface RestartedRuntime {
  owner: HealthyRuntimeOwner;
  result: CoreStartResult;
  daemonPid: number;
  daemonWasRunning: boolean;
}

/**
 * Restart the whole runtime: sashd exits through its serialized maintenance
 * boundary (so Core/system-proxy cleanup completes first) and a fresh daemon
 * process picks up the currently installed code before the Core starts again.
 */
export async function restartRuntime(
  ctx: RuntimeContext,
  deps: DaemonMaintenanceDeps = {},
): Promise<RestartedRuntime> {
  return withRuntimeOperation(ctx, "restart runtime", async () => {
    const maintenance = await prepareDaemonMaintenance(
      ctx.layout,
      ctx.settings,
      "runtime restart",
      deps,
    );

    if (maintenance.legacyDaemon) {
      // Legacy daemons predate the maintenance boundary; use the same fixed
      // offline recovery order as stop and Core update before respawning.
      await runOfflineMutation(ctx, "clean up legacy runtime", () => undefined, {
        reconcileRuntime: { legacyDaemon: true },
      });
    }

    if (!maintenance.daemonWasRunning) {
      await runOfflineMutation(ctx, "install Core before restart", () => ensureCore(ctx));
    }

    const { pid: daemonPid } = await spawnDaemon({ layout: ctx.layout, settings: ctx.settings });
    const owner = await healthyDaemonOwner(ctx);
    const result = await owner.client.startCore();
    return { owner, result, daemonPid, daemonWasRunning: maintenance.daemonWasRunning };
  });
}
