import type { DaemonMaintenanceDeps } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { ensureRunning, restartRuntime, stopRuntime } from "../runtime-owner.js";
import { type RuntimeContext, runtimeContext } from "./shared.js";

export async function runStart(): Promise<void> {
  const ctx = runtimeContext();
  const { owner, result } = await ensureRunning(ctx);
  log.ok(`core started (PID=${result.pid}${result.version ? `, version ${result.version}` : ""})`);
  printEndpoints(ctx, owner.daemon.port);
  if (ctx.settings.systemProxy) log.ok("system proxy enabled");
}

export async function runStop(): Promise<void> {
  const ctx = runtimeContext();
  const { wasRunning } = await stopRuntime(ctx);
  if (wasRunning) {
    log.ok("sash stopped; system proxy restored to its pre-Sash state");
  } else {
    log.info("sash is not running; stale runtime state was reconciled");
  }
}

export async function runRestart(deps: DaemonMaintenanceDeps = {}): Promise<void> {
  const ctx = runtimeContext();
  const { owner, result, daemonPid, daemonWasRunning } = await restartRuntime(ctx, deps);
  const verb = daemonWasRunning ? "restarted" : "started";
  log.ok(`sashd ${verb} (PID=${daemonPid})`);
  log.ok(`core ${verb} (PID=${result.pid}${result.version ? `, version ${result.version}` : ""})`);
  printEndpoints(ctx, owner.daemon.port);
}

export function printEndpoints(ctx: RuntimeContext, daemonPort: number): void {
  log.kv("mixed port", `127.0.0.1:${ctx.settings.mixedPort}`);
  log.kv("sash api", `http://127.0.0.1:${daemonPort}`);
  log.kv("dashboard", `http://127.0.0.1:${daemonPort}/ui/  (sash web to open)`);
}
