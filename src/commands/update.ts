import fs from "node:fs";
import { MihomoApi } from "../api.js";
import {
  assertCoreInstallationConsistent,
  coreInstalled,
  currentCoreVersion,
  type StagedCore,
  stageCore,
  verifyCoreExecutable,
} from "../core.js";
import { validateCoreConfigFile } from "../core-config-validation.js";
import {
  type CoreUpdateRuntime,
  commitCoreUpdate,
  finalizeCoreUpdateTransaction,
  readCoreUpdateTransaction,
  recoverCoreUpdateTransaction,
} from "../core-update.js";
import { SashDaemonClient } from "../daemon-client.js";
import {
  type DaemonMaintenanceDeps,
  type DaemonMaintenanceSnapshot,
  ensureDaemon,
  type MaintenanceDaemonClient,
  prepareDaemonMaintenance,
} from "../daemon-lifecycle.js";
import { MIHOMO_REPO, resolveLatestTag } from "../github.js";
import { log } from "../log.js";
import { isProcessAlive, readPidRecord } from "../process.js";
import { withStateLock } from "../state-lock.js";
import { CoreSupervisor } from "../supervisor.js";
import { disableLegacySystemProxyIfOwned } from "../sysproxy.js";
import { SystemProxyManager } from "../system-proxy-manager.js";
import {
  createProfileService,
  type RuntimeContext,
  runOfflineMutation,
  runtimeContext,
} from "./shared.js";

export type UpdateMaintenanceSnapshot = DaemonMaintenanceSnapshot;

interface UpdateDaemonClient extends MaintenanceDaemonClient {
  startCore(): Promise<{ pid: number; version?: string }>;
}

export interface UpdateMaintenanceDeps extends Omit<DaemonMaintenanceDeps, "clientFactory"> {
  clientFactory?: (port: number, secret: string) => UpdateDaemonClient;
  ensureDaemon?: typeof ensureDaemon;
}

/** Stop sashd and obtain the Core-running state from its serialized shutdown boundary. */
export function prepareUpdateMaintenance(
  ctx: RuntimeContext,
  deps: UpdateMaintenanceDeps = {},
): Promise<UpdateMaintenanceSnapshot> {
  return prepareDaemonMaintenance(ctx.layout, ctx.settings, "Core update", deps);
}

/** `sash update` upgrades the managed Core binary with rollback. */
export async function runUpdate(
  opts: { version?: string; force?: boolean } = {},
  deps: UpdateMaintenanceDeps = {},
): Promise<void> {
  const ctx = runtimeContext();
  const target = opts.version ?? (await resolveLatestTag(MIHOMO_REPO));
  const current = currentCoreVersion(ctx.layout);

  if (!opts.force && current && current === target) {
    const verified = await withStateLock(
      ctx.layout.runtimeOperationLockFile,
      { purpose: "verify installed Core", timeoutMs: 30_000 },
      () => {
        if (
          !coreInstalled(ctx.layout) ||
          fs.existsSync(ctx.layout.coreInstallTransactionFile) ||
          fs.existsSync(ctx.layout.coreUpdateTransactionFile) ||
          fs.existsSync(`${ctx.layout.coreExe}.bak`)
        ) {
          return false;
        }
        try {
          verifyCoreExecutable(ctx.layout.coreExe, 5000, target);
          return true;
        } catch {
          return false;
        }
      },
    );
    if (verified) {
      log.ok(`core is already up to date (${current})`);
      return;
    }
  }
  log.info(`updating core: ${current || "(none)"} → ${target}`);
  log.info("downloading and validating the replacement binary...");
  const staged = await stageCore({ layout: ctx.layout, tag: target });

  try {
    // Downloading and the authenticated maintenance request occur without the
    // runtime lock. The daemon closes its mutation gate before returning the
    // atomic Core-running snapshot, then this CLI takes runtime ownership.
    const maintenance = await prepareUpdateMaintenance(ctx, deps);
    await withStateLock(
      ctx.layout.runtimeOperationLockFile,
      { purpose: "update Core runtime", timeoutMs: 180_000 },
      () => commitStagedUpdate(ctx, staged, maintenance, deps),
    );
  } finally {
    fs.rmSync(staged.exe, { force: true });
  }
}

async function commitStagedUpdate(
  ctx: RuntimeContext,
  staged: StagedCore,
  maintenance: UpdateMaintenanceSnapshot,
  deps: UpdateMaintenanceDeps,
): Promise<void> {
  let updateError: Error | undefined;
  let resultVersion: string | undefined;
  let pendingStartupValidation = false;

  try {
    const ownedCore = readPidRecord(ctx.layout.pidFile);
    if (
      (!ownedCore || !isProcessAlive(ownedCore.pid)) &&
      (await new MihomoApi(ctx.settings.controller, ctx.settings.secret).isReachable())
    ) {
      throw new Error(
        "A Core controller is active without a live Sash PID owner; refusing to replace the executable",
      );
    }

    const result = await runOfflineMutation(
      ctx,
      "commit Core update",
      async () => {
        // A crashed daemon may have left both proxy ownership and a verified Core
        // PID behind. Reconcile those before replacing the executable.
        if (maintenance.legacyDaemon && ctx.settings.systemProxy) {
          await disableLegacySystemProxyIfOwned({ port: ctx.settings.mixedPort });
        }
        await new SystemProxyManager({ layout: ctx.layout }).release();
        const recoverySupervisor = new CoreSupervisor({
          layout: ctx.layout,
          settings: () => ctx.settings,
        });
        await recoverySupervisor.cleanStaleCore();
        recoverCoreUpdateTransaction(ctx.layout);
        assertCoreInstallationConsistent(ctx.layout);
        await createProfileService(ctx).reloadActive(false);
        await validateCoreConfigFile(staged.exe, ctx.layout.configFile, ctx.layout);

        let activeVerifier: CoreSupervisor | undefined;
        const runtime: CoreUpdateRuntime | undefined = maintenance.coreWasRunning
          ? {
              verifyRuntime: true,
              stop: async () => {
                await activeVerifier?.stop();
                activeVerifier = undefined;
              },
              startAndVerify: async (expectedVersion) => {
                activeVerifier = new CoreSupervisor({
                  layout: ctx.layout,
                  settings: () => ctx.settings,
                  expectedVersion,
                });
                const started = await activeVerifier.start();
                log.info(`Core ${expectedVersion} health check passed (PID=${started.pid})`);
              },
            }
          : undefined;

        try {
          return await commitCoreUpdate({
            layout: ctx.layout,
            staged,
            runtime,
          });
        } finally {
          await activeVerifier?.stop();
        }
      },
      { allowOrphanCore: true, migrateProfiles: true },
    );
    resultVersion = result.version;
    pendingStartupValidation = result.pendingStartupValidation;
  } catch (err) {
    updateError = err as Error;
  }

  let restartError: Error | undefined;
  const unresolvedBackup = fs.existsSync(`${ctx.layout.coreExe}.bak`);
  if (maintenance.daemonWasRunning && updateError && unresolvedBackup) {
    restartError = new Error(
      "runtime was not restarted because Core rollback ownership remains unresolved",
    );
  } else if (maintenance.daemonWasRunning) {
    try {
      await (deps.ensureDaemon ?? ensureDaemon)({ layout: ctx.layout, settings: ctx.settings });
      if (maintenance.coreWasRunning) {
        const client = (
          deps.clientFactory ?? ((port, secret) => new SashDaemonClient(port, secret))
        )(ctx.settings.daemonPort, ctx.settings.daemonSecret);
        const started = await client.startCore();
        log.info(`runtime restored (PID=${started.pid})`);
      }
    } catch (err) {
      restartError = err as Error;
    }
  }

  if (updateError) {
    const suffix = restartError ? `; runtime restoration failed: ${restartError.message}` : "";
    log.warn("update failed; the previous binary and install metadata were restored when possible");
    throw new Error(`${updateError.message}${suffix}`);
  }
  if (restartError) {
    const attemptedVersion = resultVersion ?? staged.version;
    const restoredVersion = currentCoreVersion(ctx.layout);
    if (!readCoreUpdateTransaction(ctx.layout) && restoredVersion !== attemptedVersion) {
      throw new Error(
        `Core ${attemptedVersion} failed during runtime restoration and was rolled back${restoredVersion ? ` to ${restoredVersion}` : ""}: ${restartError.message}`,
      );
    }
    throw new Error(
      `Core ${attemptedVersion} was installed and verified, but runtime restoration failed: ${restartError.message}. The previous binary remains in the rollback slot.`,
    );
  }
  if (pendingStartupValidation) {
    log.ok(
      `core ${resultVersion ?? staged.version} staged; rollback is retained until the next successful \`sash start\``,
    );
    return;
  }
  finalizeCoreUpdateTransaction(ctx.layout);
  log.ok(`core updated to ${resultVersion ?? staged.version}`);
}
