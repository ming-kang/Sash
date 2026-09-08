import { type AutostartController, AutostartService } from "../autostart.js";
import { log } from "../log.js";

export type AutoMode = "on" | "off" | "status";

export async function runAuto(
  mode?: AutoMode,
  controller: AutostartController = new AutostartService(),
): Promise<void> {
  const status =
    mode === "status"
      ? await controller.inspect()
      : await controller.set(mode === undefined ? undefined : mode === "on");
  log.kv("autostart", status.state);
  if (status.reason) log.warn(status.reason);
  if (mode === "status" && status.state === "unknown") process.exitCode = 2;
  if (status.state === "on" && mode !== "status" && process.platform === "linux") {
    log.info("For startup before login on a headless machine, run: loginctl enable-linger");
  }
}
