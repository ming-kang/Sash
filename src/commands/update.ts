import { commandOutput } from "../cli-output.js";
import { validateCoreReleaseTag } from "../core-install-record.js";
import { checkCoreUpdate } from "../core-update-check.js";
import { coreUpdateProgressText, updateCoreWithProgress } from "../core-update-client.js";
import { log } from "../log.js";
import { sashLayout } from "../paths.js";
import { ensureManagement } from "../runtime-owner.js";
import { runtimeContext } from "./shared.js";

export async function runUpdate(
  opts: { version?: string; check?: boolean; json?: boolean } = {},
): Promise<void> {
  await commandOutput(
    opts.json,
    async () => {
      const version = opts.version === undefined ? undefined : validateCoreReleaseTag(opts.version);
      if (opts.check) return checkCoreUpdate(sashLayout(), version);
      const owner = await ensureManagement(runtimeContext());
      if (!opts.json)
        process.stderr.write("[sash] Updating Core; the dashboard remains available\n");
      let previous = "";
      return updateCoreWithProgress(
        owner.client,
        version,
        opts.json
          ? undefined
          : (progress) => {
              const text = coreUpdateProgressText(progress);
              if (text !== previous) {
                previous = text;
                process.stderr.write(`[sash] ${text}\n`);
              }
            },
      );
    },
    (result) => {
      if ("available" in result)
        log.info(
          result.available
            ? `Core ${result.current ?? "unknown"} → ${result.target} is available; run sash update${opts.version ? ` ${result.target}` : ""}`
            : `Core ${result.current} is current`,
        );
      else log.ok(`core updated to ${result.version}`);
    },
  );
}
