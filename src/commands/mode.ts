import { commandOutput } from "../cli-output.js";
import type { RoutingMode } from "../contracts.js";
import { log } from "../log.js";
import { setRuntimeMode } from "../runtime-owner.js";
import { runtimeContext } from "./shared.js";

export async function runMode(mode: RoutingMode, options: { json?: boolean } = {}): Promise<void> {
  await commandOutput(
    options.json,
    async () => {
      await setRuntimeMode(runtimeContext(), mode);
      return { mode };
    },
    () => log.info(`Routing mode is now ${mode} — it lasts until you apply configuration`),
  );
}
