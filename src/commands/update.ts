import { currentCoreVersion, stageCore } from "../core.js";
import { type CoreUpdateRuntime, commitCoreUpdate } from "../core-update.js";
import { SashDaemonClient } from "../daemon-client.js";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { MIHOMO_REPO, resolveLatestTag } from "../github.js";
import { log } from "../log.js";
import { runtimeContext } from "./shared.js";

/**
 * `sash update` upgrades the mihomo core binary with atomic swap and rollback.
 */
export async function runUpdate(opts: { version?: string; force?: boolean } = {}): Promise<void> {
  const ctx = runtimeContext();
  const current = currentCoreVersion(ctx.layout);
  const target = opts.version ?? (await resolveLatestTag(MIHOMO_REPO));

  if (!opts.force && current && current === target) {
    log.ok(`mihomo core is already up to date (${current})`);
    return;
  }
  log.info(`updating mihomo core: ${current || "(none)"} → ${target}`);

  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);
  const client =
    daemonState.running && daemonState.healthy
      ? new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret)
      : undefined;

  let wasCoreRunning = false;
  if (client) {
    try {
      const status = await client.status();
      wasCoreRunning = status.core.running;
    } catch {
      // Treat an unreachable runtime as stopped; the file swap still fails
      // safely on platforms where an unmanaged process locks the binary.
    }
  }

  log.info("downloading and validating the replacement binary...");
  const staged = await stageCore({ layout: ctx.layout, tag: target });
  const runtime: CoreUpdateRuntime | undefined =
    client && wasCoreRunning
      ? {
          wasRunning: true,
          stop: async () => {
            log.info("stopping core for the update...");
            await client.stopCore();
          },
          startAndVerify: async () => {
            const result = await client.startCore();
            log.ok(`core healthy (PID=${result.pid})`);
          },
        }
      : undefined;

  try {
    const result = await commitCoreUpdate({ layout: ctx.layout, staged, runtime });
    log.ok(`mihomo core updated to ${result.version}`);
  } catch (err) {
    log.warn("update failed; the previous binary and install metadata were restored when possible");
    throw err;
  }
}
