import { loadSettings } from "../app-state.js";
import { type RuntimeContext, resolveDaemonSession } from "../daemon-session.js";
import { errorMessage } from "../error-utils.js";
import { log } from "../log.js";
import { sashLayout } from "../paths.js";

export type { RuntimeContext } from "../daemon-session.js";

/** Read-only CLI context; only the daemon initializes or publishes application state. */
export function runtimeContext(): RuntimeContext {
  const layout = sashLayout();
  return { layout, settings: loadSettings(layout) };
}

export interface CoreUpdateInterrupt {
  /** Aborted once the interrupt ran; commands use it to stop their request. */
  readonly signal: AbortSignal;
  /** True once Ctrl+C was handled. */
  readonly triggered: boolean;
  /** True only when the interrupt actually cancelled a Core download. */
  readonly cancelledDownload: boolean;
  restore(): void;
}

/**
 * Ctrl+C cancels a Core download that Sash is running, instead of only killing
 * this command: the download would otherwise continue with no command left to
 * observe or stop it. Commands that never start a download — a start with Core
 * already running — keep the plain interrupt, because there is nothing to
 * cancel. Any other disconnect still detaches and leaves the download running.
 */
export function installCoreUpdateInterrupt(
  ctx: RuntimeContext = runtimeContext(),
): CoreUpdateInterrupt {
  const controller = new AbortController();
  let triggered = false;
  let cancelledDownload = false;
  const onSigint = (): void => {
    // A second interrupt means "leave now"; the cancel request is already sent.
    if (triggered) process.exit(130);
    triggered = true;
    void (async () => {
      const session = await resolveDaemonSession(ctx).catch(() => undefined);
      if (session?.kind !== "daemon") {
        controller.abort(new Error("interrupted"));
        return;
      }
      const progress = await session.client.coreUpdateProgress().catch(() => null);
      if (!progress) {
        controller.abort(new Error("interrupted"));
        return;
      }
      cancelledDownload = true;
      process.stderr.write("[sash] Cancelling the Core download\n");
      try {
        await session.client.cancelCoreUpdate();
      } catch (error) {
        log.warn(`Core download was not cancelled: ${errorMessage(error)}`);
      }
      controller.abort(new Error("Core download cancelled"));
    })();
  };
  process.on("SIGINT", onSigint);
  return {
    signal: controller.signal,
    get triggered(): boolean {
      return triggered;
    },
    get cancelledDownload(): boolean {
      return cancelledDownload;
    },
    restore(): void {
      process.removeListener("SIGINT", onSigint);
    },
  };
}
