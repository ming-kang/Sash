import { setTun, type TunServiceDeps } from "../tun-service.js";
import { runtimeContext } from "./shared.js";

/** Change the desired TUN setting without starting or elevating the runtime. */
export async function runTun(target: "on" | "off", deps: TunServiceDeps = {}): Promise<void> {
  await setTun(runtimeContext(), target === "on", deps);
}
