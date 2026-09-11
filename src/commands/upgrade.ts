import { writeCliDebug } from "../cli-errors.js";
import { errorMessage } from "../error-utils.js";
import { log } from "../log.js";
import { exactSashVersion } from "../package-info.js";
import { executeSashUpgrade, inspectSashUpgrade } from "../self-upgrade.js";

export async function runUpgrade(
  version?: string,
  options: { check?: boolean; json?: boolean; restart?: boolean } = {},
): Promise<void> {
  try {
    const exact = version === undefined ? undefined : exactSashVersion(version);
    const { report, installation, target } = await inspectSashUpgrade(exact);
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
          `${report.reason ?? "This Sash installation cannot be upgraded automatically."}\n`,
        );
      } else if (report.available) {
        process.stdout.write(
          `Sash ${report.current} → ${report.target} is available. Run sash upgrade to install it.\n`,
        );
      } else {
        process.stdout.write(`Sash ${report.current} is already current.\n`);
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
    });
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          outcome: "upgraded",
          version: outcome.version,
          restarted: outcome.restarted,
        })}\n`,
      );
    } else if (outcome.restarted) {
      log.ok(`Sash ${outcome.version} installed · the daemon restarted on it`);
    } else {
      log.info(
        `Sash ${outcome.version} installed · restart Sash to load it: sash stop && sash start`,
      );
    }
    process.exitCode = 0;
  } catch (error) {
    if (!options.json) throw error;
    process.stdout.write(`${JSON.stringify({ outcome: "failed", error: errorMessage(error) })}\n`);
    writeCliDebug(error);
    process.exitCode = 1;
  }
}
