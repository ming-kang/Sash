import { writeCliDebug } from "../cli-errors.js";
import { errorMessage } from "../error-utils.js";
import { exactSashVersion } from "../package-info.js";
import { executeSashUpgrade, inspectSashUpgrade } from "../self-upgrade.js";

export async function runUpgrade(
  version?: string,
  options: { check?: boolean; json?: boolean } = {},
): Promise<void> {
  try {
    const exact = version === undefined ? undefined : exactSashVersion(version);
    const { report, installation } = await inspectSashUpgrade(exact);
    if (
      options.check ||
      installation.kind !== "npm-global" ||
      (!report.pending && (!report.available || !report.compatible))
    ) {
      if (options.json) {
        const outcome = !report.supported
          ? "unsupported"
          : !report.compatible
            ? "incompatible"
            : "current";
        process.stdout.write(
          `${JSON.stringify(options.check ? report : { ...report, outcome, version: report.current })}\n`,
        );
      } else if (report.pending)
        process.stdout.write(
          `Sash upgrade ${report.pending.from} → ${report.pending.target} is pending (${report.pending.phase}). Run sash upgrade to recover.\n`,
        );
      else if (!report.supported || !report.compatible)
        process.stdout.write(
          `${report.reason ?? "This Sash installation cannot be upgraded automatically."}\n`,
        );
      else if (report.available)
        process.stdout.write(
          `Sash ${report.current} → ${report.target} is available. Run sash upgrade to install it.\n`,
        );
      else process.stdout.write(`Sash ${report.current} is already current.\n`);
      if (!options.check && (!report.supported || !report.compatible)) process.exitCode = 1;
      return;
    }
    process.exitCode = await executeSashUpgrade(installation, {
      version: exact,
      json: options.json,
      recover: Boolean(report.pending),
    });
  } catch (error) {
    if (!options.json) throw error;
    process.stdout.write(`${JSON.stringify({ outcome: "failed", error: errorMessage(error) })}\n`);
    writeCliDebug(error);
    process.exitCode = 1;
  }
}
