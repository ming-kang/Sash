import type { AutostartStatus } from "../autostart/contract.js";
import { errorMessage } from "../error-utils.js";
import type { DaemonContext } from "./context.js";
import { readDaemonStatus } from "./handlers.js";

/** Desktop inspection can spawn a shell; it must not delay or repeat with download progress. */
export function createEventObserver(context: () => DaemonContext) {
  let autostart: AutostartStatus = {
    state: "unknown",
    canEnable: false,
    reason: "Autostart observation is pending",
  };
  let expiresAt = 0;
  let pending = false;
  return async () => {
    const ctx = context();
    if (!pending && Date.now() >= expiresAt) {
      pending = true;
      void Promise.resolve()
        .then(() => ctx.autostart.inspect())
        .catch(
          (error: unknown): AutostartStatus => ({
            state: "unknown",
            canEnable: false,
            reason: errorMessage(error),
          }),
        )
        .then((next) => {
          pending = false;
          expiresAt = Date.now() + 4000;
          if (JSON.stringify(next) !== JSON.stringify(autostart)) {
            autostart = next;
            ctx.events.notify();
          }
        });
    }
    const status = await readDaemonStatus(ctx);
    return { status, autostart };
  };
}
