import { assertCoreInstallationConsistent, coreInstalled, installCore } from "../core.js";
import { recoverCoreInstallTransaction } from "../core-install-transaction.js";
import { recoverCoordinatedCoreUpdate } from "../core-update-coordination.js";
import { SashDaemonClient } from "../daemon-client.js";
import {
  type DaemonHealthyInfo,
  type DaemonStoppedInfo,
  type DaemonUnhealthyInfo,
  evaluateDaemon,
} from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { type RuntimeContext, runOfflineMutation } from "../offline-mutation.js";
import { sashLayout } from "../paths.js";
import { loadSettings } from "../settings.js";

export type {
  OfflineMutationOptions,
  OfflineRuntimeReconciliation,
  RuntimeContext,
} from "../offline-mutation.js";
export { runOfflineMutation };

export type CommandRuntimeOwner =
  | { kind: "daemon"; daemon: DaemonHealthyInfo; client: SashDaemonClient }
  | { kind: "offline"; daemon: DaemonStoppedInfo }
  | { kind: "unhealthy"; daemon: DaemonUnhealthyInfo };

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

export function runtimeContext(): RuntimeContext {
  const layout = sashLayout();
  const settings = loadSettings(layout);
  return { layout, settings };
}

export async function ensureCore(ctx: RuntimeContext): Promise<void> {
  recoverCoreInstallTransaction(ctx.layout);
  recoverCoordinatedCoreUpdate(ctx.layout);
  assertCoreInstallationConsistent(ctx.layout);
  if (coreInstalled(ctx.layout)) return;
  log.info("mihomo core not installed; downloading latest release...");
  const { version } = await installCore({ layout: ctx.layout });
  log.ok(`mihomo core ${version} installed`);
}
