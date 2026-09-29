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
            log.warn(formatProxyFallbackWarning(info));
          });
        const owner = await ensureDaemonSession(runtimeContext());
        if (!opts.json)
          process.stderr.write(
            "Updating Core. Replacing a running Core briefly interrupts proxy connections.\n",
          );
        return updateCoreWithProgress(owner.client, version, printer, interrupt.signal);
      },
      (result) => {
        printer?.settle();
        if ("available" in result) {
          if (result.available) {
            log.table([
              ["Core Version", result.current ?? "Not Installed"],
              ["Available", result.target],
            ]);
            log.info(`\nRun sash update${opts.version ? ` ${result.target}` : ""} to install it.`);
          } else log.info(`Core ${result.current} is up to date.`);
        } else if (result.alreadyCurrent) log.info(`Core ${result.version} is up to date.`);
        else log.ok(`Core Updated to ${result.version}`);
      },
    );
  } catch (error) {
    if (!interrupt.triggered) throw error;
    if (interrupt.cancelledDownload) log.info("Core Download Cancelled");
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
    () => log.ok("Core Download Cancelled"),
  );
}
