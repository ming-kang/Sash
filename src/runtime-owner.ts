import fs from "node:fs";
import { loadSettings } from "./app-state.js";
import { createDaemonClient, type SashDaemonClient } from "./daemon-client.js";
import {
  type DaemonHealthyInfo,
  type DaemonStoppedInfo,
  type DaemonUnhealthyInfo,
  ensureDaemon,
  evaluateDaemon,
  stopDaemonFromCli,
} from "./daemon-lifecycle.js";
import { errorMessage } from "./error-utils.js";
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
      client: (deps.clientFactory ?? ((port, secret) => createDaemonClient(port, secret)))(
        daemon.port,
        ctx.settings.daemonSecret,
      ),
    };
  return daemon.kind === "stopped" ? { kind: "offline", daemon } : { kind: "unhealthy", daemon };
}

/** Boot the management process only; it owns all initialization and recovery. */
export async function ensureManagement(
  ctx: RuntimeContext,
  opts: { timeoutMs?: number } = {},
): Promise<HealthyRuntimeOwner> {
  await ensureDaemon({ layout: ctx.layout, settings: ctx.settings, timeoutMs: opts.timeoutMs });
  ctx.settings = loadSettings(ctx.layout);
  const owner = await resolveRuntimeOwner(ctx);
  if (owner.kind !== "daemon") throw new Error("sashd did not become healthy");
  return owner;
}

export async function ensureRunning(ctx: RuntimeContext) {
  const owner = await ensureManagement(ctx);
  return { owner, result: await owner.client.startCore() };
}

function hasRuntimeLeftovers(layout: SashLayout): boolean {
  return [layout.pidFile, layout.systemProxyStateFile, layout.coreUpdateTransactionFile].some(
    (file) => fs.existsSync(file),
  );
}

export async function stopRuntime(ctx: RuntimeContext): Promise<{ wasRunning: boolean }> {
  const initial = await resolveRuntimeOwner(ctx);
  if (initial.kind === "unhealthy")
    throw new Error(
      "sashd is unresponsive or its ownership is unknown; refusing an unverified stop",
    );
  if (initial.kind === "offline") {
    if (!hasRuntimeLeftovers(ctx.layout)) return { wasRunning: false };
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

export async function stopCoreRuntime(
  ctx: RuntimeContext,
): Promise<{ managementRunning: boolean }> {
  const owner = await resolveRuntimeOwner(ctx);
  if (owner.kind === "unhealthy")
    throw new Error("Cannot verify the management daemon; refusing an unverified Core stop");
  if (owner.kind === "offline") {
    if (!hasRuntimeLeftovers(ctx.layout)) return { managementRunning: false };
    await (await ensureManagement(ctx)).client.stopCore();
  } else await owner.client.stopCore();
  return { managementRunning: true };
}

export async function setRuntimeMode(
  ctx: RuntimeContext,
  mode: "rule" | "global" | "direct",
): Promise<void> {
  const owner = await resolveRuntimeOwner(ctx);
  if (owner.kind !== "daemon")
    throw new Error(
      "A healthy running Core is required; inspect sash status and run sash start if stopped",
    );
  await owner.client.setMode(mode);
}

export async function setRuntimeAutostart(
  ctx: RuntimeContext,
  enabled: boolean,
  onManagementStarted?: () => void,
) {
  const previous = await resolveRuntimeOwner(ctx);
  const owner = await ensureManagement(ctx);
  const managementStarted = previous.kind === "offline";
  if (managementStarted) onManagementStarted?.();
  try {
    return { ...(await owner.client.setAutostart(enabled)), managementStarted };
  } catch (error) {
    if (managementStarted)
      throw new Error(`${errorMessage(error)}. Management was started for this command`, {
        cause: error,
      });
    throw error;
  }
}
