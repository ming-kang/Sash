import fs from "node:fs";
import { loadSettings } from "./app-state.js";
import { SashDaemonClient } from "./daemon-client.js";
import {
  type DaemonHealthyInfo,
  type DaemonStoppedInfo,
  type DaemonUnhealthyInfo,
  ensureDaemon,
  evaluateDaemon,
  stopDaemonFromCli,
} from "./daemon-lifecycle.js";
import type { SashLayout } from "./paths.js";
import type { SashSettings } from "./settings.js";

export interface RuntimeContext {
  layout: SashLayout;
  settings: SashSettings;
}
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
  deps: RuntimeOwnerDependencies = {},
): Promise<CommandRuntimeOwner> {
  const daemon = await (deps.evaluateDaemon ?? evaluateDaemon)(ctx.layout, ctx.settings);
  if (daemon.kind === "healthy")
    return {
      kind: "daemon",
      daemon,
      client: (deps.clientFactory ?? ((port, secret) => new SashDaemonClient(port, secret)))(
        daemon.port,
        ctx.settings.daemonSecret,
      ),
    };
  return daemon.kind === "stopped" ? { kind: "offline", daemon } : { kind: "unhealthy", daemon };
}

/** Boot the management process only; it owns all initialization and recovery. */
export async function ensureManagement(ctx: RuntimeContext): Promise<HealthyRuntimeOwner> {
  await ensureDaemon({ layout: ctx.layout, settings: ctx.settings });
  ctx.settings = loadSettings(ctx.layout);
  const owner = await resolveRuntimeOwner(ctx);
  if (owner.kind !== "daemon") throw new Error("sashd did not become healthy");
  return owner;
}

export async function ensureRunning(ctx: RuntimeContext) {
  const owner = await ensureManagement(ctx);
  return { owner, result: await owner.client.startCore() };
}

export async function stopRuntime(ctx: RuntimeContext): Promise<{ wasRunning: boolean }> {
  const initial = await resolveRuntimeOwner(ctx);
  if (initial.kind === "unhealthy")
    throw new Error(
      "sashd is unresponsive or its ownership is unknown; refusing an unverified stop",
    );
  if (initial.kind === "offline") {
    const leftovers = [
      ctx.layout.pidFile,
      ctx.layout.systemProxyStateFile,
      ctx.layout.coreUpdateTransactionFile,
    ];
    if (!leftovers.some((file) => fs.existsSync(file))) return { wasRunning: false };
    await ensureManagement(ctx);
  }
  if (!(await stopDaemonFromCli({ layout: ctx.layout, settings: ctx.settings })))
    throw new Error("sashd shutdown could not be verified");
  return { wasRunning: initial.kind === "daemon" };
}

export async function restartRuntime(ctx: RuntimeContext) {
  const owner = await ensureManagement(ctx);
  return { owner, result: await owner.client.restartCore() };
}
