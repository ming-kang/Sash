import { log } from "../log.js";
import { ensureRunning, restartRuntime, stopCoreRuntime, stopRuntime } from "../runtime-owner.js";
import { type RuntimeContext, runtimeContext } from "./shared.js";

export async function runStart(): Promise<void> {
  const ctx = runtimeContext();
  const { owner, result } = await ensureRunning(ctx);
  const state =
    result.alreadyRunning === true
      ? "already running"
      : result.alreadyRunning === false
        ? "started"
        : "running";
  log.ok(`core ${state} (PID=${result.pid}${result.version ? `, version ${result.version}` : ""})`);
  printEndpoints(ctx, owner.daemon.port, result.mixedPort);
}
export async function runStop(options: { core?: boolean } = {}): Promise<void> {
  if (options.core) {
    const result = await stopCoreRuntime(runtimeContext());
    log.info(
      result.managementRunning ? "Core stopped; management remains available" : "Core is stopped",
    );
    return;
  }
  const result = await stopRuntime(runtimeContext());
  log.info(
    result.wasRunning ? "sash stopped; previous system proxy state restored" : "sash is stopped",
  );
}
export async function runRestart(): Promise<void> {
  const ctx = runtimeContext();
  const { owner, result } = await restartRuntime(ctx);
  log.ok(`core restarted (PID=${result.pid})`);
  printEndpoints(ctx, owner.daemon.port, result.mixedPort);
}
function printEndpoints(
  ctx: RuntimeContext,
  daemonPort: number,
  mixedPort = ctx.settings.mixedPort,
): void {
  log.kv("mixed port", `127.0.0.1:${mixedPort}`);
  log.kv("sash api", `http://127.0.0.1:${daemonPort}`);
  log.kv("dashboard", `http://127.0.0.1:${daemonPort}/ui/  (sash web to open)`);
}
