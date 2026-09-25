import { commandOutput, coreUpdateProgressPrinter } from "../cli-output.js";
import { validateCoreReleaseTag } from "../core.js";
import { checkCoreUpdate, updateCoreWithProgress } from "../core-update.js";
import { ensureDaemonSession, resolveDaemonSession } from "../daemon-session.js";
import { formatProxyFallbackWarning } from "../http.js";
import { log } from "../log.js";
import { sashLayout } from "../paths.js";
import { installCoreUpdateInterrupt, runtimeContext } from "./shared.js";

export async function runUpdate(
  opts: { version?: string; check?: boolean; cancel?: boolean; json?: boolean } = {},
): Promise<void> {
  if (opts.cancel) {
    if (opts.check) throw new Error("--cancel checks nothing; drop --check to cancel a download");
    await cancelUpdate(opts.json === true);
    return;
  }
  const interrupt = installCoreUpdateInterrupt();
  const printer = opts.json ? undefined : coreUpdateProgressPrinter();
  try {
    await commandOutput(
      opts.json,
      async () => {
        const version =
          opts.version === undefined ? undefined : validateCoreReleaseTag(opts.version);
        if (opts.check)
          return checkCoreUpdate(sashLayout(), version, interrupt.signal, (info) => {
            process.stderr.write(`[sash] ${formatProxyFallbackWarning(info)}\n`);
          });
        const owner = await ensureDaemonSession(runtimeContext());
        if (!opts.json)
          process.stderr.write(
            "[sash] Updating Core; the proxy pauses briefly when the Core binary is replaced\n",
          );
        return updateCoreWithProgress(owner.client, version, printer, interrupt.signal);
      },
      (result) => {
        if ("available" in result)
          log.info(
            result.available
              ? `Core ${result.current ?? "unknown"} → ${result.target} is available — run sash update${opts.version ? ` ${result.target}` : ""}`
              : `Core ${result.current} is up to date`,
          );
        else if (result.alreadyCurrent) log.info(`Core ${result.version} is up to date`);
        else log.ok(`Core updated to ${result.version}`);
      },
    );
  } catch (error) {
    if (!interrupt.triggered) throw error;
    if (interrupt.cancelledDownload) log.info("Core download cancelled");
  } finally {
    interrupt.restore();
    printer?.settle();
    if (interrupt.triggered) process.exitCode = 130;
  }
}

async function cancelUpdate(json: boolean): Promise<void> {
  const ctx = runtimeContext();
  await commandOutput(
    json,
    async () => {
      const session = await resolveDaemonSession(ctx);
      if (session.kind !== "daemon")
        throw new Error("Sash is not running — there is no Core download to cancel");
      await session.client.cancelCoreUpdate();
      return { cancelled: true };
    },
    () => log.ok("Core download cancelled"),
  );
}
