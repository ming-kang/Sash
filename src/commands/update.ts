import fs from "node:fs";
import { MihomoApi } from "../api.js";
import { currentCoreVersion, type StagedCore, stageCore, verifyCoreExecutable } from "../core.js";
import { validateCoreConfigFile } from "../core-config-validation.js";
import {
  type CoreUpdateRuntime,
  commitCoreUpdate,
  finalizeCoreUpdateBackup,
  recoverInterruptedCoreUpdate,
} from "../core-update.js";
import { SashDaemonClient } from "../daemon-client.js";
import { ensureDaemon, evaluateDaemon, stopDaemonFromCli } from "../daemon-lifecycle.js";
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

/** `sash update` upgrades the managed Core binary with rollback. */
export async function runUpdate(opts: { version?: string; force?: boolean } = {}): Promise<void> {
  const ctx = runtimeContext();
  const target = opts.version ?? (await resolveLatestTag(MIHOMO_REPO));
  const current = currentCoreVersion(ctx.layout);

  if (!opts.force && current && current === target) {
    const verified = await withStateLock(
      ctx.layout.runtimeOperationLockFile,
      { purpose: "verify installed Core", timeoutMs: 30_000 },
      () => {
        if (!fs.existsSync(ctx.layout.coreExe) || fs.existsSync(`${ctx.layout.coreExe}.bak`)) {
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
    await withStateLock(
      ctx.layout.runtimeOperationLockFile,
      { purpose: "update Core runtime", timeoutMs: 180_000 },
      () => commitStagedUpdate(ctx, staged),
    );
  } finally {
    fs.rmSync(staged.exe, { force: true });
  }
}

async function commitStagedUpdate(ctx: RuntimeContext, staged: StagedCore): Promise<void> {
  let daemonWasRunning = false;
  let legacyDaemon = false;
  let coreWasRunning = false;
  let updateError: Error | undefined;
  let resultVersion: string | undefined;

  try {
    const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);
    if (daemonState.running && !daemonState.healthy) {
      throw new Error("sashd is running but unresponsive; refusing a competing Core update");
    }

    daemonWasRunning = daemonState.running;
    legacyDaemon = daemonState.legacyOwnership === true;
    if (daemonWasRunning) {
      const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
      coreWasRunning = (await client.status()).core.running;
      const stopped = await stopDaemonFromCli({
        layout: ctx.layout,
        settings: ctx.settings,
        timeoutMs: 12_000,
      });
      if (!stopped) throw new Error("Could not stop sashd safely for the Core update");
    }

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
        if (legacyDaemon && ctx.settings.systemProxy) {
          await disableLegacySystemProxyIfOwned({ port: ctx.settings.mixedPort });
        }
        await new SystemProxyManager({ layout: ctx.layout }).release();
        const recoverySupervisor = new CoreSupervisor({
          layout: ctx.layout,
          settings: () => ctx.settings,
        });
        await recoverySupervisor.cleanStaleCore();
        recoverInterruptedCoreUpdate(ctx.layout);
        await createProfileService(ctx).reloadActive(false);
        await validateCoreConfigFile(staged.exe, ctx.layout.configFile, ctx.layout);

        let activeVerifier: CoreSupervisor | undefined;
        const runtime: CoreUpdateRuntime | undefined = coreWasRunning
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
            retainBackup: true,
          });
        } finally {
          await activeVerifier?.stop();
        }
      },
      { allowOrphanCore: true },
    );
    resultVersion = result.version;
  } catch (err) {
    updateError = err as Error;
  }

  let restartError: Error | undefined;
  const unresolvedBackup = fs.existsSync(`${ctx.layout.coreExe}.bak`);
  if (daemonWasRunning && updateError && unresolvedBackup) {
    restartError = new Error(
      "runtime was not restarted because Core rollback ownership remains unresolved",
    );
  } else if (daemonWasRunning) {
    try {
      await ensureDaemon({ layout: ctx.layout, settings: ctx.settings });
      if (coreWasRunning) {
        const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
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
    throw new Error(
      `Core ${resultVersion ?? staged.version} was installed and verified, but runtime restoration failed: ${restartError.message}. The previous binary remains in the rollback slot.`,
    );
  }
  finalizeCoreUpdateBackup(ctx.layout);
  log.ok(`core updated to ${resultVersion ?? staged.version}`);
}
