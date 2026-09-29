import { commandOutput } from "../cli-output.js";
import type { RoutingMode } from "../contracts.js";
import { setRuntimeMode } from "../daemon-session.js";
import { log } from "../log.js";
import { runtimeContext } from "./shared.js";

export async function runMode(mode: RoutingMode, options: { json?: boolean } = {}): Promise<void> {
  await commandOutput(
    options.json,
    async () => {
      await setRuntimeMode(runtimeContext(), mode);
      return { mode };
    },
    () => {
      log.table([["Mode", mode[0]?.toUpperCase() + mode.slice(1)]]);
      log.info(
        "\nApplies to the current Core session. Applying the saved configuration may reset it.",
      );
    },
  );
}
