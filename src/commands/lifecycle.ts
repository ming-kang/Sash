import { coreUpdateProgressPrinter } from "../cli-output.js";
import { log } from "../log.js";
import { ensureRunning, restartRuntime, stopCoreRuntime, stopRuntime } from "../runtime-owner.js";
import { type RuntimeContext, runtimeContext } from "./shared.js";

export async function runStart(): Promise<void> {
  const ctx = runtimeContext();
  const { owner, result } = await ensureRunning(ctx, {
    onCoreUpdateProgress: coreUpdateProgressPrinter(),
  });
  const version = result.version ? ` (${result.version})` : "";
  const core = `Core ${result.alreadyRunning === true ? "already running" : "running"}${version}`;
  log.ok(
    result.alreadyRunning === true ? `Sash already running · ${core}` : `Sash started · ${core}`,
  );
  printEndpoints(ctx, owner.daemon.port, result.mixedPort);
}
export async function runStop(options: { core?: boolean } = {}): Promise<void> {
  if (options.core) {
    const result = await stopCoreRuntime(runtimeContext());
    log.info(
      result.managementRunning
        ? "Core stopped; the dashboard is still available"
        : "Core is already stopped",
    );
    return;
  }
  const ctx = runtimeContext();
  const result = await stopRuntime(ctx);
  log.info(
    !result.wasRunning
      ? "Sash is already stopped"
      : ctx.settings.systemProxy
        ? "Sash stopped · Windows system proxy restored"
        : "Sash stopped",
  );
}
export async function runRestart(): Promise<void> {
  const ctx = runtimeContext();
  const { owner, result } = await restartRuntime(ctx);
  log.ok("Configuration applied · Core restarted");
  printEndpoints(ctx, owner.daemon.port, result.mixedPort);
}
function printEndpoints(
  ctx: RuntimeContext,
  daemonPort: number,
  mixedPort = ctx.settings.mixedPort,
): void {
  log.kv("proxy port", `127.0.0.1:${mixedPort}`);
  log.kv("dashboard", `http://127.0.0.1:${daemonPort}/ui/  (sash web to open)`);
  log.kv("local API", `http://127.0.0.1:${daemonPort}`);
}
