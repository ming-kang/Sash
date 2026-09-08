import { AutostartService } from "../autostart.js";
import type { AutostartStatus } from "../autostart-contract.js";
import { log } from "../log.js";
import { ensureManagement } from "../runtime-owner.js";
import { runtimeContext } from "./shared.js";

export type AutoMode = "on" | "off" | "status";
export interface AutoController {
  inspect(): Promise<AutostartStatus>;
  set(enabled: boolean): Promise<AutostartStatus>;
}

export async function runAuto(
  mode: AutoMode = "status",
  controller: AutoController = {
    inspect: () => new AutostartService().inspect(),
    set: async (enabled) => (await ensureManagement(runtimeContext())).client.setAutostart(enabled),
  },
): Promise<void> {
  const status =
    mode === "status" ? await controller.inspect() : await controller.set(mode === "on");
  log.kv("autostart", status.state);
  if (status.reason) log.warn(status.reason);
  if (mode === "status" && status.state === "unknown") process.exitCode = 2;
}
