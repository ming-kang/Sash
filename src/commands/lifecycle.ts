import type { CoreStartResult } from "../contracts.js";
import {
  type DaemonMaintenanceDeps,
  ensureDaemon,
  prepareDaemonMaintenance,
  spawnDaemon,
  stopDaemonFromCli,
} from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { withStateLock } from "../state-lock.js";
import { tunPrivilegeGuidance } from "../tun-guidance.js";
import {
  type CommandRuntimeOwner,
  ensureCore,
  type RuntimeContext,
  resolveRuntimeOwner,
  runOfflineMutation,
  runtimeContext,
} from "./shared.js";

type HealthyCommandRuntimeOwner = Extract<CommandRuntimeOwner, { kind: "daemon" }>;

function withRuntimeOperation<T>(
  ctx: RuntimeContext,
  purpose: string,
  action: () => T | Promise<T>,
): Promise<T> {
  return withStateLock(ctx.layout.runtimeOperationLockFile, { purpose, timeoutMs: 120_000 }, () =>
    action(),
  );
}

async function healthyDaemonOwner(ctx: RuntimeContext): Promise<HealthyCommandRuntimeOwner> {
  const owner = await resolveRuntimeOwner(ctx);
  if (owner.kind !== "daemon") {
    throw new Error("sashd did not become healthy after startup");
  }
  return owner;
}

export async function runStart(): Promise<void> {
  const ctx = runtimeContext();
  await withRuntimeOperation(ctx, "start runtime", async () => {
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
    log.ok(
      `core started (PID=${result.pid}${result.version ? `, version ${result.version}` : ""})`,
    );
    printEndpoints(ctx, owner.daemon.port);
    reportTunState(ctx, result);
    if (ctx.settings.systemProxy) log.ok("system proxy enabled");
  });
}

export async function runStop(): Promise<void> {
  const ctx = runtimeContext();
  await withRuntimeOperation(ctx, "stop runtime", async () => {
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

    if (owner.kind !== "offline") {
      log.ok("sash stopped; system proxy restored to its pre-Sash state");
    } else {
      log.info("sash is not running; stale runtime state was reconciled");
    }
  });
}

/**
 * Restart the whole runtime: sashd exits through its serialized maintenance
 * boundary (so Core/system-proxy cleanup completes first) and a fresh daemon
 * process picks up the currently installed code before the Core starts again.
 */
export async function runRestart(deps: DaemonMaintenanceDeps = {}): Promise<void> {
  const ctx = runtimeContext();
  await withRuntimeOperation(ctx, "restart runtime", async () => {
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
    const verb = maintenance.daemonWasRunning ? "restarted" : "started";
    log.ok(`sashd ${verb} (PID=${daemonPid})`);
    log.ok(
      `core ${verb} (PID=${result.pid}${result.version ? `, version ${result.version}` : ""})`,
    );
    printEndpoints(ctx, owner.daemon.port);
    reportTunState(ctx, result);
  });
}

function reportTunState(ctx: RuntimeContext, result: CoreStartResult): void {
  if (!ctx.settings.tun) return;
  if (result.tunActive === true) {
    log.ok("TUN active");
  } else if (result.tunActive === false) {
    log.warn(
      `TUN was requested but is inactive; the core remains available without TUN. ${tunPrivilegeGuidance("runtime-inactive", { root: ctx.layout.root })}`,
    );
  } else {
    log.warn(
      `TUN was requested, but its runtime state could not be verified. ${tunPrivilegeGuidance("runtime-inactive", { root: ctx.layout.root })}`,
    );
  }
}

export function printEndpoints(ctx: RuntimeContext, daemonPort: number): void {
  log.kv("mixed port", `127.0.0.1:${ctx.settings.mixedPort}`);
  log.kv("sash api", `http://127.0.0.1:${daemonPort}`);
  log.kv("dashboard", `http://127.0.0.1:${daemonPort}/ui/  (sash web to open)`);
}
