import { AutostartService } from "../autostart.js";
import type { AutostartStatus } from "../autostart-contract.js";
import { commandOutput } from "../cli-output.js";
import { log } from "../log.js";
import { setRuntimeAutostart } from "../runtime-owner.js";
import { formatAutostart } from "../status.js";
import { runtimeContext } from "./shared.js";

export type AutoMode = "on" | "off" | "status";
export interface AutoController {
  inspect(): Promise<AutostartStatus>;
  set(enabled: boolean, onManagementStarted?: () => void): Promise<AutostartStatus>;
}

export async function runAuto(
  mode: AutoMode = "status",
  controller: AutoController = {
    inspect: () => new AutostartService().inspect(),
    set: (enabled, onStarted) => setRuntimeAutostart(runtimeContext(), enabled, onStarted),
  },
  options: { json?: boolean } = {},
): Promise<void> {
  await commandOutput(
    options.json,
    async () => {
      const status =
        mode === "status"
          ? await controller.inspect()
          : await controller.set(mode === "on", () => {
              if (!options.json) log.info("Starting Sash to change the login startup entry");
            });
      if (mode === "status" && status.state === "unknown") process.exitCode = 2;
      return status;
    },
    (status) => {
      log.kv("start at login", formatAutostart(status));
    },
  );
}
