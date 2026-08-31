import fs from "node:fs";
import { currentCoreVersion, installCore } from "../core.js";
import { SashDaemonClient } from "../daemon-client.js";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { MIHOMO_REPO, resolveLatestTag } from "../github.js";
import { log } from "../log.js";
import { waitForBinaryUnlocked } from "../process.js";
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
      if (wasCoreRunning) {
        log.info("stopping core for the update...");
        await client.stopCore();
      }
    } catch {
      // ignore
    }
  }

  const backup = `${ctx.layout.coreExe}.bak`;
  let backedUp = false;
  try {
    if (fs.existsSync(ctx.layout.coreExe)) {
      await waitForBinaryUnlocked(ctx.layout.coreExe);
      fs.renameSync(ctx.layout.coreExe, backup);
      backedUp = true;
    }
    const { version } = await installCore({ layout: ctx.layout, tag: target });
    ctx.settings.coreVersion = version;

    if (wasCoreRunning && client) {
      const result = await client.startCore();
      log.ok(`core restarted (PID=${result.pid})`);
    }

    fs.rmSync(backup, { force: true });
    log.ok(`mihomo core updated to ${target}`);
  } catch (err) {
    if (backedUp && fs.existsSync(backup)) {
      log.warn("update failed; rolling back to the previous core binary");
      try {
        if (fs.existsSync(ctx.layout.coreExe)) fs.rmSync(ctx.layout.coreExe, { force: true });
        fs.renameSync(backup, ctx.layout.coreExe);
        if (wasCoreRunning && client) {
          await client.startCore().catch(() => undefined);
        }
      } catch {
        log.error(`rollback failed; previous binary preserved at ${backup}`);
      }
    }
    throw err;
  }
}
