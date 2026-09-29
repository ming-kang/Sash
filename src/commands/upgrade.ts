import { writeCliDebug } from "../cli-errors.js";
import { errorMessage } from "../error-utils.js";
import { log } from "../log.js";
import { exactSashVersion } from "../package-info.js";
import { executeSashUpgrade, inspectSashUpgrade, resolveNpmRegistry } from "../self-upgrade.js";

export async function runUpgrade(
  version?: string,
  options: { check?: boolean; json?: boolean; restart?: boolean } = {},
): Promise<void> {
  try {
    const exact = version === undefined ? undefined : exactSashVersion(version);
    const { report, installation, target } = await inspectSashUpgrade(exact, {
      registry: await resolveNpmRegistry(),
    });
    const installable = installation.kind === "npm-global";
    if (options.check || !installable || !report.available || !report.compatible) {
      if (options.json) {
        const outcome = !report.supported
          ? "unsupported"
          : !report.compatible
            ? "incompatible"
            : "current";
        process.stdout.write(
          `${JSON.stringify(options.check ? report : { ...report, outcome, version: report.current })}\n`,
        );
      } else if (!report.supported || !report.compatible) {
        process.stdout.write(
          `${report.reason ?? "This Sash installation cannot be upgraded automatically"}\n`,
        );
      } else if (report.available) {
        log.table([
          ["Sash Version", report.current],
          ["Available", report.target ?? "Unknown"],
        ]);
        log.info(`\nRun sash upgrade${exact ? ` ${exact}` : ""} to install it.`);
      } else {
        process.stdout.write(`Sash ${report.current} is up to date.\n`);
      }
      if (!options.check && (!report.supported || !report.compatible)) process.exitCode = 1;
      return;
    }
    if (!target)
      throw new Error(
        "internal error: an installable upgrade resolved no target; please report this",
      );
    const outcome = await executeSashUpgrade(installation, target, {
      json: options.json === true,
      restart: options.restart !== false,
      ...(options.json
        ? {}
        : {
            onPhase: (phase) => {
              process.stderr.write(
                phase === "restarting" ? "Restarting Sash\n" : "Starting Core\n",
              );
            },
          }),
    });
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          outcome: "upgraded",
          version: outcome.version,
          restarted: outcome.restarted,
          coreRestarted: outcome.coreRestarted,
          autostartRepaired: outcome.autostartRepaired === true,
          ...(outcome.coreRestartError !== undefined
            ? { coreRestartError: outcome.coreRestartError }
            : {}),
        })}\n`,
      );
    } else if (outcome.restarted) {
      log.ok(`Sash Upgraded to ${outcome.version} · Restarted`);
      if (outcome.autostartRepaired === true) log.info("Auto Start Repaired");
    } else {
      log.info(
        outcome.wasRunning
          ? `Sash ${outcome.version} Installed · Restart Required\nRun sash stop, then sash start to load it.`
          : `Sash ${outcome.version} Installed\nRun sash start to start it.`,
      );
    }
    if (outcome.coreRestartError !== undefined) {
      if (!options.json) {
        log.error(
          `Core did not start: ${outcome.coreRestartError}\nRun sash logs --errors, then sash doctor.`,
        );
      }
      process.exitCode = 1;
    } else {
      process.exitCode = 0;
    }
  } catch (error) {
    if (!options.json) throw error;
    process.stdout.write(`${JSON.stringify({ outcome: "failed", error: errorMessage(error) })}\n`);
    writeCliDebug(error);
    process.exitCode = 1;
  }
}
