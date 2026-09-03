import { assertCoreInstallationConsistent, coreInstalled, installCore } from "../core.js";
import { validateCoreConfigText } from "../core-config-validation.js";
import { recoverCoreInstallTransaction } from "../core-install-transaction.js";
import { recoverCoordinatedCoreUpdate } from "../core-update-coordination.js";
import { log } from "../log.js";
import { type RuntimeContext, runOfflineMutation } from "../offline-mutation.js";
import { sashLayout } from "../paths.js";
import { type ProfileCommitBoundary, ProfileService } from "../profile-service.js";
import { loadSettings } from "../settings.js";

export type {
  OfflineMutationOptions,
  OfflineRuntimeReconciliation,
  RuntimeContext,
} from "../offline-mutation.js";
export { runOfflineMutation };

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

/**
 * Offline profile preparation may fetch and validate freely; this boundary
 * acquires ownership only for the final recheck and publication.
 */
export function offlineProfileCommit(ctx: RuntimeContext): ProfileCommitBoundary {
  return (purpose, action) => runOfflineMutation(ctx, purpose, action);
}

/** Recover and run one-time profile migrations before an offline profile snapshot is read. */
export async function prepareOfflineProfileMutation(ctx: RuntimeContext): Promise<void> {
  await runOfflineMutation(ctx, "prepare profile mutation", () => undefined, {
    migrateProfiles: true,
  });
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
