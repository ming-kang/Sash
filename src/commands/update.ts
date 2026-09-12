import { commandOutput, coreUpdateProgressPrinter } from "../cli-output.js";
import { validateCoreReleaseTag } from "../core.js";
import { checkCoreUpdate, updateCoreWithProgress } from "../core-update.js";
import { formatProxyFallbackWarning } from "../http.js";
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
      if (opts.check)
        return checkCoreUpdate(sashLayout(), version, undefined, (info) => {
          process.stderr.write(`[sash] ${formatProxyFallbackWarning(info)}\n`);
        });
      const owner = await ensureManagement(runtimeContext());
      if (!opts.json)
        process.stderr.write(
          "[sash] Updating Core; the proxy pauses briefly while the Core binary is replaced\n",
        );
      return updateCoreWithProgress(
        owner.client,
        version,
        opts.json ? undefined : coreUpdateProgressPrinter(),
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
