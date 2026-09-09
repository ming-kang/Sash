import { commandOutput } from "../cli-output.js";
import { log } from "../log.js";
import { setRuntimeMode } from "../runtime-owner.js";
import { runtimeContext } from "./shared.js";

export type RoutingMode = "rule" | "global" | "direct";

export async function runMode(mode: RoutingMode, options: { json?: boolean } = {}): Promise<void> {
  await commandOutput(
    options.json,
    async () => {
      await setRuntimeMode(runtimeContext(), mode);
      return { mode };
    },
    () => log.info(`Runtime mode set to ${mode}; Apply restores the saved profile's mode`),
  );
}
