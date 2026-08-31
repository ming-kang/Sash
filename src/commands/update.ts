import fs from "node:fs";
import { currentCoreVersion, installCore } from "../core.js";
import { MIHOMO_REPO, resolveLatestTag } from "../github.js";
import { log } from "../log.js";
import { evaluateRunning, startDaemon, stopDaemon, waitForBinaryUnlocked } from "../process.js";
import { runtimeContext } from "./shared.js";

/**
 * `sash update` upgrades the mihomo core binary (and only the core; `sash
 * upgrade` upgrades Sash itself). The swap is atomic with rollback: the old
 * binary is kept as <exe>.bak until the new one boots and answers the API.
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

  const state = await evaluateRunning(ctx.layout, ctx.settings);
  const wasRunning = state.running;
  if (wasRunning) {
    log.info("stopping core for the update...");
    await stopDaemon({ layout: ctx.layout });
  }

  const backup = `${ctx.layout.coreExe}.bak`;
  let backedUp = false;
  try {
    if (fs.existsSync(ctx.layout.coreExe)) {
      await waitForBinaryUnlocked(ctx.layout);
      fs.renameSync(ctx.layout.coreExe, backup);
      backedUp = true;
    }
    const { version } = await installCore({ layout: ctx.layout, tag: target });
    ctx.settings.coreVersion = version;
    if (wasRunning) {
      const { pid } = await startDaemon({ layout: ctx.layout, settings: ctx.settings });
      log.ok(`core restarted (pid ${pid})`);
    }
    fs.rmSync(backup, { force: true });
    log.ok(`mihomo core updated to ${target}`);
  } catch (err) {
    if (backedUp && fs.existsSync(backup)) {
      log.warn("update failed; rolling back to the previous core binary");
      try {
        if (fs.existsSync(ctx.layout.coreExe)) fs.rmSync(ctx.layout.coreExe, { force: true });
        fs.renameSync(backup, ctx.layout.coreExe);
        if (wasRunning) {
          await startDaemon({ layout: ctx.layout, settings: ctx.settings }).catch(() => undefined);
        }
      } catch {
        log.error(`rollback failed; previous binary preserved at ${backup}`);
      }
    }
    throw err;
  }
}
