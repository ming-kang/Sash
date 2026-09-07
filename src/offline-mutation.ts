import fs from "node:fs";
import { assertCoreInstallationConsistent } from "./core.js";
import { recoverCoreInstallTransaction } from "./core-install-transaction.js";
import { recoverCoordinatedCoreUpdate } from "./core-update-coordination.js";
import { evaluateDaemon } from "./daemon-lifecycle.js";
import {
  readManagedStateTransactionStatus,
  recoverManagedStateTransaction,
} from "./managed-state-transaction.js";
import type { SashLayout } from "./paths.js";
import { isProcessAlive, readPidRecord } from "./process.js";
import { migrateProfileState } from "./profile-migration.js";
import { type RuntimeRecoveryDeps, reconcileOrphanedRuntime } from "./runtime-recovery.js";
import { loadSettings, type SashSettings } from "./settings.js";
import { withStateLock } from "./state-lock.js";

export interface RuntimeContext {
  layout: SashLayout;
  settings: SashSettings;
}

export interface OfflineRuntimeReconciliation {
  legacyDaemon?: boolean;
  verifyControllerVacant?: boolean;
  /** Injectable only for deterministic coordination tests. */
  deps?: RuntimeRecoveryDeps;
}

export interface OfflineMutationOptions {
  reconcileRuntime?: OfflineRuntimeReconciliation;
  /** Only the explicit forced Core update may preserve an inconsistent pair for journaled repair. */
  allowInconsistentCore?: "force-update";
  migrateProfiles?: boolean;
}

/**
 * Run a disk mutation only when no daemon owns the data directory. The daemon
 * takes the same lock during initialization and all control mutations.
 */
export async function runOfflineMutation<T>(
  ctx: RuntimeContext,
  purpose: string,
  action: () => T | Promise<T>,
  options: OfflineMutationOptions = {},
): Promise<T> {
  return withStateLock(ctx.layout.mutationLockFile, { purpose, timeoutMs: 30_000 }, async () => {
    // The context may have waited behind another CLI. Refresh the committed
    // snapshot only after acquiring the cross-process mutation lock.
    ctx.settings = loadSettings(ctx.layout);
    const daemon = await evaluateDaemon(ctx.layout, ctx.settings);
    if (daemon.kind !== "stopped") {
      const owner = daemon.pid ? ` (PID=${daemon.pid})` : "";
      throw new Error(
        `sashd owns the data directory${owner} but is not accepting this operation; stop or recover it before retrying`,
      );
    }

    const reconciliation = options.reconcileRuntime;
    if (!reconciliation) {
      const core = readPidRecord(ctx.layout.pidFile);
      if (!core && fs.existsSync(ctx.layout.pidFile)) {
        throw new Error(
          `Core PID record is corrupt: ${ctx.layout.pidFile}; reconcile it before modifying state`,
        );
      }
      if (core && isProcessAlive(core.pid)) {
        throw new Error(
          `Core PID ${core.pid} is still alive without sashd; run \`sash stop\` to reconcile it before modifying state`,
        );
      }
    }

    recoverCoreInstallTransaction(ctx.layout);
    if (reconciliation) {
      const managed = readManagedStateTransactionStatus(ctx.layout);
      if (managed?.coordination !== "core-update") {
        recoverManagedStateTransaction(ctx.layout);
      }
      ctx.settings = loadSettings(ctx.layout);
      await reconcileOrphanedRuntime(
        {
          layout: ctx.layout,
          settings: ctx.settings,
          ...(reconciliation.legacyDaemon ? { legacyDaemon: reconciliation.legacyDaemon } : {}),
          ...(reconciliation.verifyControllerVacant
            ? { verifyControllerVacant: reconciliation.verifyControllerVacant }
            : {}),
        },
        reconciliation.deps,
      );
    } else {
      recoverCoordinatedCoreUpdate(ctx.layout);
      if (options.allowInconsistentCore !== "force-update") {
        assertCoreInstallationConsistent(ctx.layout);
      }
    }

    // Recovery may have restored sash.json from an interrupted transaction.
    ctx.settings = loadSettings(ctx.layout);
    if (options.migrateProfiles) {
      // Legacy subscriptionUrl migration runs first so it remains canonical;
      // only a still-uninitialized profile store may import config.yaml.
      await migrateProfileState(ctx.settings, ctx.layout);
    }
    return action();
  });
}
