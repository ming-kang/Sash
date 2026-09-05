import { MihomoApi } from "./api.js";
import type { CoreUpdateTransaction } from "./core-update.js";
import { recoverCoordinatedCoreUpdate } from "./core-update-coordination.js";
import type { SashLayout } from "./paths.js";
import type { recoverServiceRuntime } from "./service-runtime.js";
import type { SashSettings } from "./settings.js";
import { CoreSupervisor } from "./supervisor.js";
import { disableLegacySystemProxyIfOwned } from "./sysproxy.js";
import { SystemProxyManager } from "./system-proxy-manager.js";

interface RuntimeRecoverySystemProxy {
  release(): Promise<void>;
}

interface RuntimeRecoverySupervisor {
  cleanStaleCore(): Promise<void>;
}

export type CoreControllerProbe = (settings: SashSettings) => Promise<boolean>;

export interface RuntimeRecoveryDeps {
  recoverService?: typeof recoverServiceRuntime;
  disableLegacyProxy?: typeof disableLegacySystemProxyIfOwned;
  systemProxy?: RuntimeRecoverySystemProxy;
  supervisor?: RuntimeRecoverySupervisor;
  recoverCoreUpdate?: (layout: SashLayout) => CoreUpdateTransaction | undefined;
  controllerReachable?: CoreControllerProbe;
}

export interface ReconcileOrphanedRuntimeOptions {
  layout: SashLayout;
  settings: SashSettings;
  legacyDaemon?: boolean;
  /** Used by executable replacement to reject an unowned controller endpoint. */
  verifyControllerVacant?: boolean;
}

export async function assertCoreControllerVacant(
  settings: SashSettings,
  probe: CoreControllerProbe = (current) =>
    new MihomoApi(current.controller, current.secret).isReachable(),
): Promise<void> {
  if (await probe(settings)) {
    throw new Error(
      "A Core controller is active without a live Sash PID owner; refusing to replace the executable",
    );
  }
}

/**
 * Reconcile runtime artifacts left without a healthy daemon. The order is part
 * of the safety boundary: legacy endpoint cleanup, journaled proxy restoration,
 * verified stale-Core termination, then coordinated update recovery.
 */
export async function reconcileOrphanedRuntime(
  options: ReconcileOrphanedRuntimeOptions,
  deps: RuntimeRecoveryDeps = {},
): Promise<CoreUpdateTransaction | undefined> {
  const { layout, settings } = options;
  if (options.legacyDaemon && settings.systemProxy) {
    await (deps.disableLegacyProxy ?? disableLegacySystemProxyIfOwned)({
      port: settings.mixedPort,
    });
  }

  const systemProxy = deps.systemProxy ?? new SystemProxyManager({ layout });
  await systemProxy.release();

  const serviceInstalled = await (
    deps.recoverService ??
    (deps.supervisor
      ? async () => false
      : async (root, current) =>
          (await import("./service-runtime.js")).recoverServiceRuntime(root, current))
  )(layout, settings);

  const supervisor =
    deps.supervisor ??
    new CoreSupervisor({
      layout,
      settings: () => settings,
    });
  if (!serviceInstalled) await supervisor.cleanStaleCore();
  if (serviceInstalled && options.verifyControllerVacant) {
    throw new Error(
      "Service-backed Core updates require an explicit elevated administrative refresh",
    );
  }

  const pending = (deps.recoverCoreUpdate ?? recoverCoordinatedCoreUpdate)(layout);
  if (options.verifyControllerVacant) {
    await assertCoreControllerVacant(settings, deps.controllerReachable);
  }
  return pending;
}
