import { loadSettings } from "../app-state.js";
import { type RuntimeContext, resolveDaemonSession } from "../daemon-session.js";
import { errorMessage } from "../error-utils.js";
import { log } from "../log.js";
import { sashLayout } from "../paths.js";

export type { RuntimeContext } from "../daemon-session.js";

export function runtimeContext(): RuntimeContext {
  const layout = sashLayout();
  return { layout, settings: loadSettings(layout) };
}

export interface CoreUpdateInterrupt {
  readonly signal: AbortSignal;
  readonly triggered: boolean;
  readonly cancelledDownload: boolean;
  restore(): void;
}

export function installCoreUpdateInterrupt(
  ctx: RuntimeContext = runtimeContext(),
): CoreUpdateInterrupt {
  const controller = new AbortController();
  let triggered = false;
  let cancelledDownload = false;
  const interrupt = (): void => controller.abort(new Error("interrupted"));
  const cancelDownloadOrInterrupt = async (): Promise<void> => {
    const session = await resolveDaemonSession(ctx).catch(() => undefined);
    if (session?.kind !== "daemon") return interrupt();
    const progress = await session.client.coreUpdateProgress().catch(() => null);
    if (!progress) return interrupt();
    process.stderr.write("Cancelling Core Download\n");
    try {
      await session.client.cancelCoreUpdate();
      cancelledDownload = true;
    } catch (error) {
      log.warn(`Core download was not cancelled: ${errorMessage(error)}`);
    }
    controller.abort(new Error("Core download cancelled"));
  };
  const onSigint = (): void => {
    if (triggered) process.exit(130);
    triggered = true;
    void cancelDownloadOrInterrupt();
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
