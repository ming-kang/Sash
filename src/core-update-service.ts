import fs from "node:fs";
import {
  assertCoreInstallationConsistent,
  coreInstalled,
  currentCoreVersion,
  type StagedCore,
  stageCore,
  verifyCoreExecutable,
} from "./core.js";
import {
  validateCoreConfigFile,
  validateCoreConfigTextWithExecutable,
} from "./core-config-validation.js";
import {
  type CoreUpdateResult,
  type CoreUpdateRuntime,
  commitCoreUpdate,
  readCoreUpdateTransaction,
} from "./core-update.js";
import { finalizeCoordinatedCoreUpdate } from "./core-update-coordination.js";
import { SashDaemonClient } from "./daemon-client.js";
import {
  type DaemonMaintenanceDeps,
  type DaemonMaintenanceSnapshot,
  ensureDaemon,
  evaluateDaemon,
  type MaintenanceDaemonClient,
  prepareDaemonMaintenance,
} from "./daemon-lifecycle.js";
import { MIHOMO_REPO, resolveLatestTag } from "./github.js";
import { log } from "./log.js";
import {
  readManagedStateTransactionStatus,
  retainManagedStateTransaction,
  rollbackRetainedManagedStateTransaction,
} from "./managed-state-transaction.js";
import { type RuntimeContext, runOfflineMutation } from "./offline-mutation.js";
import { ProfileConflictError, ProfileService } from "./profile-service.js";
import { assertCoreControllerVacant, type RuntimeRecoveryDeps } from "./runtime-recovery.js";
import { loadSettings } from "./settings.js";
import { withStateLock } from "./state-lock.js";
import { CoreSupervisor, type CoreSupervisorOptions } from "./supervisor.js";

export type UpdateMaintenanceSnapshot = DaemonMaintenanceSnapshot;

type CoreExecutableVerifier = (exe: string, expectedVersion: string) => void;

interface UpdateDaemonClient extends MaintenanceDaemonClient {
  startCore(): Promise<{ pid: number; version?: string }>;
}

interface UpdateVerificationSupervisor {
  start(): Promise<{ pid: number }>;
  stop(): Promise<void>;
}

export interface UpdateMaintenanceDeps extends Omit<DaemonMaintenanceDeps, "clientFactory"> {
  clientFactory?: (port: number, secret: string) => UpdateDaemonClient;
  ensureDaemon?: typeof ensureDaemon;
}

export interface CoreUpdateServiceDeps extends UpdateMaintenanceDeps {
  resolveLatestTag?: typeof resolveLatestTag;
  stageCore?: typeof stageCore;
  validateConfigText?: typeof validateCoreConfigTextWithExecutable;
  validateConfigFile?: typeof validateCoreConfigFile;
  verifyExecutable?: CoreExecutableVerifier;
  runtimeRecovery?: RuntimeRecoveryDeps;
  createVerificationSupervisor?: (options: CoreSupervisorOptions) => UpdateVerificationSupervisor;
}

/** Stop sashd and obtain the Core-running state from its serialized shutdown boundary. */
export function prepareUpdateMaintenance(
  ctx: RuntimeContext,
  deps: UpdateMaintenanceDeps = {},
): Promise<UpdateMaintenanceSnapshot> {
  return prepareDaemonMaintenance(ctx.layout, ctx.settings, "Core update", deps);
}

function defaultCoreVerifier(exe: string, expectedVersion: string): void {
  verifyCoreExecutable(exe, 5000, expectedVersion);
}

function installedTargetIsVerified(
  ctx: RuntimeContext,
  target: string,
  verifier: CoreExecutableVerifier,
): boolean {
  if (
    currentCoreVersion(ctx.layout) !== target ||
    !coreInstalled(ctx.layout) ||
    fs.existsSync(ctx.layout.coreInstallTransactionFile) ||
    fs.existsSync(ctx.layout.coreUpdateTransactionFile) ||
    readManagedStateTransactionStatus(ctx.layout) ||
    fs.existsSync(`${ctx.layout.coreExe}.bak`) ||
    fs.existsSync(`${ctx.layout.coreExe}.repair.bak`) ||
    fs.existsSync(`${ctx.layout.installFile}.repair.bak`)
  ) {
    return false;
  }
  try {
    verifier(ctx.layout.coreExe, target);
    return true;
  } catch {
    return false;
  }
}

/** Download outside runtime ownership, then coordinate maintenance and publication under it. */
export async function runCoreUpdate(
  ctx: RuntimeContext,
  opts: { version?: string; force?: boolean } = {},
  deps: CoreUpdateServiceDeps = {},
): Promise<void> {
  const target = opts.version ?? (await (deps.resolveLatestTag ?? resolveLatestTag)(MIHOMO_REPO));
  const current = currentCoreVersion(ctx.layout);
  const verifier = deps.verifyExecutable ?? defaultCoreVerifier;

  if (!opts.force) {
    const verified = await withStateLock(
      ctx.layout.runtimeOperationLockFile,
      { purpose: "verify installed Core", timeoutMs: 30_000 },
      () => installedTargetIsVerified(ctx, target, verifier),
    );
    if (verified) {
      log.ok(`core is already up to date (${target})`);
      return;
    }
  }

  log.info(`updating core: ${current || "(none)"} → ${target}`);
  log.info("downloading and validating the replacement binary...");
  const staged = await (deps.stageCore ?? stageCore)({ layout: ctx.layout, tag: target });

  try {
    await withStateLock(
      ctx.layout.runtimeOperationLockFile,
      { purpose: "update Core runtime", timeoutMs: 180_000 },
      async () => {
        // Another updater may have committed while this process staged outside
        // runtime ownership. Recheck before stopping a healthy daemon.
        if (!opts.force && installedTargetIsVerified(ctx, target, verifier)) {
          log.ok(`core is already up to date (${target})`);
          return;
        }
        ctx.settings = loadSettings(ctx.layout);
        const maintenance = await prepareUpdateMaintenance(ctx, deps);
        await commitStagedCoreUpdate(ctx, staged, maintenance, deps, opts.force === true, verifier);
      },
    );
  } finally {
    fs.rmSync(staged.exe, { force: true });
  }
}

async function commitStagedCoreUpdate(
  ctx: RuntimeContext,
  staged: StagedCore,
  maintenance: UpdateMaintenanceSnapshot,
  deps: CoreUpdateServiceDeps,
  forceRepair: boolean,
  verifier: CoreExecutableVerifier,
): Promise<void> {
  let updateError: Error | undefined;
  let resultVersion: string | undefined;
  let pendingStartupValidation = false;

  try {
    // This is the sole per-update legacy/proxy/orphan cleanup. It reloads the
    // final committed settings under mutation ownership before probing the
    // controller endpoint used by the replacement transaction.
    await runOfflineMutation(
      ctx,
      "prepare Core update profile",
      () => {
        if (!forceRepair) assertCoreInstallationConsistent(ctx.layout);
      },
      {
        reconcileRuntime: {
          ...(maintenance.legacyDaemon ? { legacyDaemon: true } : {}),
          verifyControllerVacant: true,
          ...(deps.runtimeRecovery ? { deps: deps.runtimeRecovery } : {}),
        },
        migrateProfiles: true,
      },
    );

    const profileService = new ProfileService({
      layout: ctx.layout,
      settings: () => ctx.settings,
      validateConfig: (generated) =>
        (deps.validateConfigText ?? validateCoreConfigTextWithExecutable)(
          staged.exe,
          generated.yaml,
          ctx.layout,
        ),
    });

    const commitPreparedUpdate = async (attempt = 0): Promise<CoreUpdateResult> => {
      const preparedProfile = await profileService.prepareActiveReload();
      let callbackEntered = false;
      try {
        return await runOfflineMutation(
          ctx,
          "commit Core update",
          () =>
            profileService.withPreparedActiveReloadPublication(
              preparedProfile,
              async (publication) => {
                await assertCoreControllerVacant(
                  ctx.settings,
                  deps.runtimeRecovery?.controllerReachable,
                );
                callbackEntered = true;
                await retainManagedStateTransaction(ctx.layout, {
                  index: publication.index,
                  ...(publication.profile
                    ? {
                        profile: {
                          id: publication.profile.id,
                          yamlText: publication.profile.yamlText,
                        },
                      }
                    : {}),
                  config: publication.config,
                  reloadRuntime: false,
                });

                let coreCommitStarted = false;
                try {
                  await (deps.validateConfigFile ?? validateCoreConfigFile)(
                    staged.exe,
                    ctx.layout.configFile,
                    ctx.layout,
                  );

                  let activeVerifier: UpdateVerificationSupervisor | undefined;
                  const runtime: CoreUpdateRuntime | undefined = maintenance.coreWasRunning
                    ? {
                        verifyRuntime: true,
                        stop: async () => {
                          await activeVerifier?.stop();
                          activeVerifier = undefined;
                        },
                        startAndVerify: async (expectedVersion) => {
                          activeVerifier = deps.createVerificationSupervisor
                            ? deps.createVerificationSupervisor({
                                layout: ctx.layout,
                                settings: () => ctx.settings,
                                expectedVersion,
                              })
                            : new CoreSupervisor({
                                layout: ctx.layout,
                                settings: () => ctx.settings,
                                expectedVersion,
                              });
                          const started = await activeVerifier.start();
                          log.info(
                            `Core ${expectedVersion} health check passed (PID=${started.pid})`,
                          );
                        },
                      }
                    : undefined;

                  try {
                    coreCommitStarted = true;
                    return await commitCoreUpdate({
                      layout: ctx.layout,
                      staged,
                      runtime,
                      forceRepair,
                      verifyExecutable: verifier,
                      beforeRollback: () => {
                        rollbackRetainedManagedStateTransaction(ctx.layout);
                      },
                    });
                  } finally {
                    await activeVerifier?.stop();
                  }
                } catch (err) {
                  if (!coreCommitStarted) {
                    try {
                      rollbackRetainedManagedStateTransaction(ctx.layout);
                    } catch (rollbackErr) {
                      throw new Error(
                        `${(err as Error).message}; managed-state rollback also failed: ${(rollbackErr as Error).message}`,
                      );
                    }
                  }
                  throw err;
                }
              },
            ),
          {
            ...(forceRepair ? { allowInconsistentCore: "force-update" as const } : {}),
            migrateProfiles: true,
          },
        );
      } catch (err) {
        if (callbackEntered || !(err instanceof ProfileConflictError) || attempt >= 1) throw err;
        return commitPreparedUpdate(attempt + 1);
      }
    };

    const result = await commitPreparedUpdate();
    resultVersion = result.version;
    pendingStartupValidation = result.pendingStartupValidation;
  } catch (err) {
    updateError = err as Error;
  }

  let recoveryError: Error | undefined;
  if (updateError) {
    try {
      await runOfflineMutation(ctx, "recover failed Core update", () => undefined, {
        reconcileRuntime: {
          ...(deps.runtimeRecovery ? { deps: deps.runtimeRecovery } : {}),
        },
      });
    } catch (err) {
      recoveryError = err as Error;
    }
  }

  ctx.settings = loadSettings(ctx.layout);
  let restartError: Error | undefined;
  if (maintenance.daemonWasRunning && recoveryError) {
    restartError = new Error(
      `runtime was not restarted because update rollback ownership remains unresolved: ${recoveryError.message}`,
    );
  } else if (maintenance.daemonWasRunning) {
    try {
      await (deps.ensureDaemon ?? ensureDaemon)({ layout: ctx.layout, settings: ctx.settings });
      ctx.settings = loadSettings(ctx.layout);
      if (maintenance.coreWasRunning) {
        const daemon = await (deps.evaluateDaemon ?? evaluateDaemon)(ctx.layout, ctx.settings);
        if (daemon.kind !== "healthy") {
          throw new Error("sashd did not become healthy during update restoration");
        }
        const client = (
          deps.clientFactory ?? ((port, secret) => new SashDaemonClient(port, secret))
        )(daemon.port, ctx.settings.daemonSecret);
        const started = await client.startCore();
        log.info(`runtime restored (PID=${started.pid})`);
      }
    } catch (err) {
      restartError = err as Error;
    }
  }

  if (updateError) {
    const suffix = recoveryError
      ? `; update recovery failed: ${recoveryError.message}${maintenance.daemonWasRunning ? "; runtime was not restarted" : ""}`
      : restartError
        ? `; runtime restoration failed: ${restartError.message}`
        : "";
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
  finalizeCoordinatedCoreUpdate(ctx.layout, verifier);
  log.ok(`core updated to ${resultVersion ?? staged.version}`);
}
