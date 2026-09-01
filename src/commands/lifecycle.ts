import { SashDaemonClient } from "../daemon-client.js";
import { ensureDaemon, evaluateDaemon, stopDaemonFromCli } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { withStateLock } from "../state-lock.js";
import { CoreSupervisor } from "../supervisor.js";
import { disableLegacySystemProxyIfOwned } from "../sysproxy.js";
import { SystemProxyManager } from "../system-proxy-manager.js";
import { ensureCore, type RuntimeContext, runOfflineMutation, runtimeContext } from "./shared.js";

function withRuntimeOperation<T>(
  ctx: RuntimeContext,
  purpose: string,
  action: () => T | Promise<T>,
): Promise<T> {
  return withStateLock(ctx.layout.runtimeOperationLockFile, { purpose, timeoutMs: 120_000 }, () =>
    action(),
  );
}

export async function runStart(): Promise<void> {
  const ctx = runtimeContext();
  await withRuntimeOperation(ctx, "start runtime", async () => {
    const daemon = await evaluateDaemon(ctx.layout, ctx.settings);
    if (daemon.running && !daemon.healthy) {
      throw new Error("sashd is already starting or unresponsive; refusing a competing start");
    }
    if (!daemon.running) {
      await runOfflineMutation(ctx, "install Core before start", () => ensureCore(ctx));
    }

    await ensureDaemon({ layout: ctx.layout, settings: ctx.settings });
    const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
    const status = await client.status();
    if (status.core.running) {
      if (!status.core.healthy) {
        throw new Error(`core process is running but unhealthy (PID=${status.core.pid})`);
      }
      log.info(`core is already running (PID=${status.core.pid})`);
      printEndpoints(ctx);
      return;
    }

    const result = await client.startCore();
    log.ok(
      `core started (PID=${result.pid}${result.version ? `, version ${result.version}` : ""})`,
    );
    printEndpoints(ctx);
    if (ctx.settings.tun) {
      log.warn(
        "TUN is enabled: the core usually needs Administrator/root privileges to create the interface.",
      );
    }
    if (ctx.settings.systemProxy) log.ok("system proxy enabled");
  });
}

export async function runStop(): Promise<void> {
  const ctx = runtimeContext();
  await withRuntimeOperation(ctx, "stop runtime", async () => {
    const state = await evaluateDaemon(ctx.layout, ctx.settings);
    if (state.running) {
      const stopped = await stopDaemonFromCli({ layout: ctx.layout, settings: ctx.settings });
      if (!stopped) return;
    }

    await runOfflineMutation(
      ctx,
      "finalize stopped runtime",
      async () => {
        if (state.legacyOwnership && ctx.settings.systemProxy) {
          await disableLegacySystemProxyIfOwned({ port: ctx.settings.mixedPort });
        }
        await new SystemProxyManager({ layout: ctx.layout }).release();
        const supervisor = new CoreSupervisor({
          layout: ctx.layout,
          settings: () => ctx.settings,
        });
        await supervisor.cleanStaleCore();
      },
      { allowOrphanCore: true },
    );

    if (state.running) {
      log.ok("sash stopped; system proxy restored to its pre-Sash state");
    } else {
      log.info("sash is not running; stale runtime state was reconciled");
    }
  });
}

export async function runRestart(): Promise<void> {
  const ctx = runtimeContext();
  await withRuntimeOperation(ctx, "restart runtime", async () => {
    const daemon = await evaluateDaemon(ctx.layout, ctx.settings);
    if (daemon.running && !daemon.healthy) {
      throw new Error("sashd is already starting or unresponsive; refusing a competing restart");
    }
    if (!daemon.running) {
      await runOfflineMutation(ctx, "install Core before restart", () => ensureCore(ctx));
    }

    await ensureDaemon({ layout: ctx.layout, settings: ctx.settings });
    const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
    const result = await client.restartCore();
    log.ok(
      `core restarted (PID=${result.pid}${result.version ? `, version ${result.version}` : ""})`,
    );
    printEndpoints(ctx);
  });
}

export function printEndpoints(ctx: RuntimeContext): void {
  log.kv("mixed port", `127.0.0.1:${ctx.settings.mixedPort}`);
  log.kv("sash api", `http://127.0.0.1:${ctx.settings.daemonPort}`);
  log.kv("dashboard", `http://127.0.0.1:${ctx.settings.daemonPort}/ui/  (sash web to open)`);
}
