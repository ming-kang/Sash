import { coreUpdateProgressPrinter } from "../cli-output.js";
import { ensureRunning, restartRuntime, stopCoreRuntime, stopRuntime } from "../daemon-session.js";
import { log } from "../log.js";
import { installCoreUpdateInterrupt, type RuntimeContext, runtimeContext } from "./shared.js";

export async function runStart(): Promise<void> {
  const ctx = runtimeContext();
  const interrupt = installCoreUpdateInterrupt(ctx);
  const printer = coreUpdateProgressPrinter();
  try {
    const { owner, result } = await ensureRunning(ctx, {
      onCoreUpdateProgress: printer,
      signal: interrupt.signal,
    });
    printer.settle();
    log.ok(result.alreadyRunning ? "Sash & Core Already Running" : "Sash & Core Running");
    printEndpoints(ctx, owner.daemon.port, result.mixedPort);
  } catch (error) {
    if (!interrupt.triggered) throw error;
    if (interrupt.cancelledDownload) log.info("Core Download Cancelled");
  } finally {
    interrupt.restore();
    printer.settle();
    if (interrupt.triggered) process.exitCode = 130;
  }
}
export async function runStop(options: { core?: boolean } = {}): Promise<void> {
  if (options.core) {
    const result = await stopCoreRuntime(runtimeContext());
    log.info(result.daemonRunning ? "Core Stopped · Sash Running" : "Core Already Stopped");
    return;
  }
  const ctx = runtimeContext();
  const result = await stopRuntime(ctx);
  log.info(result.wasRunning ? "Sash & Core Stopped" : "Sash & Core Already Stopped");
}
export async function runRestart(): Promise<void> {
  const ctx = runtimeContext();
  const interrupt = installCoreUpdateInterrupt(ctx);
  try {
    const { owner, result } = await restartRuntime(ctx, { signal: interrupt.signal });
    log.ok(
      result.alreadyRunning === true
        ? "Configuration Applied · Connections Kept"
        : "Configuration Applied · Core Started",
    );
    printEndpoints(ctx, owner.daemon.port, result.mixedPort);
  } catch (error) {
    if (!interrupt.triggered) throw error;
    if (interrupt.cancelledDownload) log.info("Core Download Cancelled");
  } finally {
    interrupt.restore();
    if (interrupt.triggered) process.exitCode = 130;
  }
}
function printEndpoints(
  ctx: RuntimeContext,
  daemonPort: number,
  mixedPort = ctx.settings.mixedPort,
): void {
  log.table([
    ["Proxy Port", `127.0.0.1:${mixedPort}`],
    ["WebUI", `127.0.0.1:${daemonPort}`],
  ]);
}
