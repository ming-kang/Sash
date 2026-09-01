import fs from "node:fs";
import { assertCoreInstallationConsistent, coreInstalled, installCore } from "../core.js";
import { validateCoreConfigText } from "../core-config-validation.js";
import { recoverCoreInstallTransaction } from "../core-install-transaction.js";
import { recoverInterruptedCoreUpdate } from "../core-update.js";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { recoverManagedStateTransaction } from "../managed-state-transaction.js";
import { type SashLayout, sashLayout } from "../paths.js";
import { isProcessAlive, readPidRecord } from "../process.js";
import { migrateLegacyProfileSetting } from "../profile-migration.js";
import { type ProfileCommitBoundary, ProfileService } from "../profile-service.js";
import { loadSettings, type SashSettings } from "../settings.js";
import { withStateLock } from "../state-lock.js";

export interface RuntimeContext {
  layout: SashLayout;
  settings: SashSettings;
}

export interface OfflineMutationOptions {
  allowOrphanCore?: boolean;
}

export function runtimeContext(): RuntimeContext {
  const layout = sashLayout();
  const settings = loadSettings(layout);
  return { layout, settings };
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
    if (daemon.running) {
      const owner = daemon.pid ? ` (PID=${daemon.pid})` : "";
      throw new Error(
        `sashd owns the data directory${owner} but is not accepting this operation; stop or recover it before retrying`,
      );
    }
    if (!options.allowOrphanCore) {
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
    assertCoreInstallationConsistent(ctx.layout);
    recoverManagedStateTransaction(ctx.layout);
    migrateLegacyProfileSetting(ctx.settings, ctx.layout);
    return action();
  });
}

export async function ensureCore(ctx: RuntimeContext): Promise<void> {
  recoverCoreInstallTransaction(ctx.layout);
  recoverInterruptedCoreUpdate(ctx.layout);
  assertCoreInstallationConsistent(ctx.layout);
  if (coreInstalled(ctx.layout)) return;
  log.info("mihomo core not installed; downloading latest release...");
  const { version } = await installCore({ layout: ctx.layout });
  log.ok(`mihomo core ${version} installed`);
}

/**
 * Offline profile preparation may fetch and validate freely; this boundary
 * acquires ownership only for the final recheck and publication.
 */
export function offlineProfileCommit(ctx: RuntimeContext): ProfileCommitBoundary {
  return (purpose, action) => runOfflineMutation(ctx, purpose, action);
}

/** Commit a legacy-setting migration before an offline profile snapshot is read. */
export async function prepareOfflineProfileMutation(ctx: RuntimeContext): Promise<void> {
  await runOfflineMutation(ctx, "prepare profile mutation", () => undefined);
}

export function createProfileService(
  ctx: RuntimeContext,
  commit?: ProfileCommitBoundary,
): ProfileService {
  return new ProfileService({
    layout: ctx.layout,
    settings: () => ctx.settings,
    ...(coreInstalled(ctx.layout)
      ? { validateConfig: (generated) => validateCoreConfigText(generated.yaml, ctx.layout) }
      : {}),
    ...(commit ? { commit } : {}),
  });
}
