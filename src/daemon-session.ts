import fs from "node:fs";
import { loadSettings } from "./app-state.js";
import type { RoutingMode } from "./contracts.js";
import { type CoreUpdateProgressPrinter, withCoreUpdateProgress } from "./core-update.js";
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
import { createDaemonClient, type SashDaemonClient } from "./sash-client-node.js";
import type { SashSettings } from "./settings.js";

export interface RuntimeContext {
  layout: SashLayout;
  settings: SashSettings;
}
export type DaemonSession =
  | { kind: "daemon"; daemon: DaemonHealthyInfo; client: SashDaemonClient }
  | { kind: "offline"; daemon: DaemonStoppedInfo }
  | { kind: "unhealthy"; daemon: DaemonUnhealthyInfo };
export type HealthyDaemonSession = Extract<DaemonSession, { kind: "daemon" }>;
export interface DaemonSessionDependencies {
  evaluateDaemon?: typeof evaluateDaemon;
  clientFactory?: (port: number, secret: string) => SashDaemonClient;
}

export async function resolveDaemonSession(
  ctx: RuntimeContext,
  deps: DaemonSessionDependencies = {},
): Promise<DaemonSession> {
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

/** Boot the background process only; it owns all initialization and recovery. */
export async function ensureDaemonSession(
  ctx: RuntimeContext,
  opts: { timeoutMs?: number } = {},
): Promise<HealthyDaemonSession> {
  await ensureDaemon({ layout: ctx.layout, settings: ctx.settings, timeoutMs: opts.timeoutMs });
  ctx.settings = loadSettings(ctx.layout);
  const owner = await resolveDaemonSession(ctx);
  if (owner.kind !== "daemon") {
    throw new Error("Sash did not become healthy — run sash doctor to diagnose");
  }
  return owner;
}

export async function ensureRunning(
  ctx: RuntimeContext,
  opts: {
    onCoreUpdateProgress?: CoreUpdateProgressPrinter;
    signal?: AbortSignal;
  } = {},
) {
  const owner = await ensureDaemonSession(ctx);
  const start = owner.client.startCore({ ...(opts.signal ? { signal: opts.signal } : {}) });
  const result = opts.onCoreUpdateProgress
    ? await withCoreUpdateProgress(owner.client, start, opts.onCoreUpdateProgress.onProgress)
    : await start;
  return { owner, result };
}

function hasRuntimeLeftovers(layout: SashLayout): boolean {
  return [layout.pidFile, layout.systemProxyStateFile, layout.coreUpdateTransactionFile].some(
    (file) => fs.existsSync(file),
  );
}

export async function stopRuntime(ctx: RuntimeContext): Promise<{ wasRunning: boolean }> {
  const initial = await resolveDaemonSession(ctx);
  if (initial.kind === "unhealthy")
    throw new Error(
      "Sash is unresponsive or its ownership is unknown; refusing an unverified stop",
    );
  if (initial.kind === "offline") {
    if (!hasRuntimeLeftovers(ctx.layout)) return { wasRunning: false };
    await ensureDaemonSession(ctx);
  }
  if (!(await stopDaemonFromCli({ layout: ctx.layout, settings: ctx.settings })))
    throw new Error("Sash shutdown could not be verified — run sash doctor to diagnose");
  return { wasRunning: initial.kind === "daemon" };
}

export async function restartRuntime(ctx: RuntimeContext, opts: { signal?: AbortSignal } = {}) {
  const owner = await ensureDaemonSession(ctx);
  return {
    owner,
    result: await owner.client.restartCore({ ...(opts.signal ? { signal: opts.signal } : {}) }),
  };
}

export async function stopCoreRuntime(ctx: RuntimeContext): Promise<{ daemonRunning: boolean }> {
  const owner = await resolveDaemonSession(ctx);
  if (owner.kind === "unhealthy")
    throw new Error("Cannot verify the running Sash; refusing an unverified Core stop");
  if (owner.kind === "offline") {
    if (!hasRuntimeLeftovers(ctx.layout)) return { daemonRunning: false };
    await (await ensureDaemonSession(ctx)).client.stopCore();
  } else await owner.client.stopCore();
  return { daemonRunning: true };
}

export async function setRuntimeMode(ctx: RuntimeContext, mode: RoutingMode): Promise<void> {
  const owner = await resolveDaemonSession(ctx);
  if (owner.kind !== "daemon")
    throw new Error(
      "A healthy running Core is required; inspect sash status and run sash start if stopped",
    );
  await owner.client.setMode(mode);
}

export async function setRuntimeAutostart(
  ctx: RuntimeContext,
  enabled: boolean,
  onDaemonStarted?: () => void,
) {
  const previous = await resolveDaemonSession(ctx);
  const owner = await ensureDaemonSession(ctx);
  const daemonStarted = previous.kind === "offline";
  if (daemonStarted) onDaemonStarted?.();
  try {
    return { ...(await owner.client.setAutostart(enabled)), daemonStarted };
  } catch (error) {
    if (daemonStarted)
      throw new Error(`${errorMessage(error)}. Sash was started for this command`, {
        cause: error,
      });
    throw error;
  }
}
