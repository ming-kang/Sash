import { errorMessage } from "../error-utils.js";
import type { TunGuardLike, TunGuardReconcileResult, TunGuardVerb } from "../tun-guard.js";
import type { HostedCore } from "../tun-service.js";
import {
  HELPER_PROTOCOL,
  type HelperReply,
  helperGuardUnsupportedWarning,
  requestHelper,
} from "./helper-pipe.js";

const PROBE_TIMEOUT_MS = 5_000;

interface QueuedReconcile {
  verb: TunGuardVerb;
  waiters: Array<() => void>;
}

export interface WindowsGuardHost extends HostedCore {
  probeGuard?: () => Promise<HelperReply>;
}

export interface WindowsTunGuardDeps {
  host: WindowsGuardHost;
  probe?: () => Promise<HelperReply>;
}

export class WindowsTunGuard implements TunGuardLike {
  // Status and doctor hide unsupported guards; keep degradation visible in lastResult.
  readonly supported = true;

  private readonly host: WindowsGuardHost;
  private readonly probe: () => Promise<HelperReply>;
  private draining: Promise<void> | undefined;
  private queued: QueuedReconcile | undefined;
  private result: TunGuardReconcileResult | undefined;
  private lastWarnKey: string | undefined;

  constructor(deps: WindowsTunGuardDeps) {
    this.host = deps.host;
    this.probe =
      deps.probe ??
      deps.host.probeGuard?.bind(deps.host) ??
      (() => requestHelper("status", PROBE_TIMEOUT_MS));
  }

  lastResult(): TunGuardReconcileResult | undefined {
    return this.result;
  }

  reconcile(desired: TunGuardVerb): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.queued) {
        this.queued.verb = desired;
        this.queued.waiters.push(resolve);
      } else {
        this.queued = { verb: desired, waiters: [resolve] };
      }
      if (!this.draining) this.draining = this.drain();
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      const job = this.queued;
      if (!job) {
        this.draining = undefined;
        return;
      }
      this.queued = undefined;
      try {
        await this.invoke(job.verb);
      } catch {
        // invoke records operational failures; this guards programming errors.
      }
      for (const resolve of job.waiters) resolve();
    }
  }

  private async invoke(verb: TunGuardVerb): Promise<void> {
    if (verb === "setup") {
      await this.setup();
      return;
    }
    await this.teardown();
  }

  private unsupportedDetail(reply: HelperReply): string | null {
    if (reply.protocol < HELPER_PROTOCOL) return helperGuardUnsupportedWarning(reply);
    if (reply.protocol > HELPER_PROTOCOL)
      return `the TUN service speaks protocol ${reply.protocol}; this Sash needs ${HELPER_PROTOCOL}`;
    return null;
  }

  private async setup(): Promise<void> {
    try {
      const reply = await this.probe();
      const unsupported = this.unsupportedDetail(reply);
      if (unsupported) {
        this.record({ state: "unavailable", verb: "setup", detail: unsupported });
        return;
      }
      this.record({ state: "ok", verb: "setup", detail: null });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const missing =
        code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES" || code === "EPERM";
      this.record({
        state: missing ? "unavailable" : "failed",
        verb: "setup",
        detail: missing
          ? `the TUN service is unreachable; reinstall it: sash tun helper install (${errorMessage(error)})`
          : errorMessage(error),
      });
    }
  }

  private async teardown(): Promise<void> {
    try {
      await this.host.unguard();
      this.record({ state: "ok", verb: "teardown", detail: null });
    } catch (error) {
      let state: TunGuardReconcileResult["state"] = "failed";
      let detail = errorMessage(error);
      try {
        const unsupported = this.unsupportedDetail(await this.probe());
        if (unsupported) {
          state = "unavailable";
          detail = unsupported;
        }
      } catch {
        // The original unguard error is the actionable failure.
      }
      this.record({ state, verb: "teardown", detail });
    }
  }

  private record(result: Omit<TunGuardReconcileResult, "at">): void {
    this.result = { ...result, at: new Date().toISOString() };
    if (result.state === "ok") {
      this.lastWarnKey = undefined;
      return;
    }
    const key = `${result.state}:${result.verb}:${result.detail ?? ""}`;
    if (key === this.lastWarnKey) return;
    this.lastWarnKey = key;
    console.warn(
      `[sashd] TUN guard ${result.verb} ${result.state}: ${result.detail ?? "unknown error"}`,
    );
  }
}

export function windowsTunGuard(
  host: WindowsGuardHost,
  deps: Omit<WindowsTunGuardDeps, "host"> = {},
): TunGuardLike {
  return new WindowsTunGuard({ ...deps, host });
}
