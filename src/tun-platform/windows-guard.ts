import { errorMessage } from "../error-utils.js";
import type {
  TunGuardLike,
  TunGuardObservation,
  TunGuardReconcileResult,
  TunGuardVerb,
} from "../tun-guard.js";
import type { HostedCore } from "../tun-service.js";
import {
  HELPER_PROTOCOL,
  type HelperReply,
  helperGuardUnsupportedWarning,
  requestHelper,
} from "./helper-pipe.js";
import { guardFromReply } from "./windows.js";

const PROBE_TIMEOUT_MS = 5_000;

interface QueuedReconcile {
  verb: TunGuardVerb;
  waiters: Array<(result: TunGuardReconcileResult | undefined) => void>;
}

export interface WindowsGuardHost extends HostedCore {
  probeGuard?: () => Promise<HelperReply>;
}

export interface WindowsTunGuardDeps {
  host: WindowsGuardHost;
  readHelperStatus?: () => Promise<HelperReply>;
}

export class WindowsTunGuard implements TunGuardLike {
  // Status and doctor hide unsupported guards; keep degradation visible in lastResult.
  readonly supported = true;

  private readonly host: WindowsGuardHost;
  private readonly readHelperStatus: () => Promise<HelperReply>;
  private draining: Promise<void> | undefined;
  private queued: QueuedReconcile | undefined;
  private result: TunGuardReconcileResult | undefined;
  private lastWarnKey: string | undefined;

  constructor(deps: WindowsTunGuardDeps) {
    this.host = deps.host;
    this.readHelperStatus =
      deps.readHelperStatus ??
      deps.host.probeGuard?.bind(deps.host) ??
      (() => requestHelper("status", PROBE_TIMEOUT_MS));
  }

  lastResult(): TunGuardReconcileResult | undefined {
    return this.result;
  }

  async readFreshStatus(): Promise<TunGuardObservation> {
    const reply = await this.readHelperStatus();
    const detail = this.unsupportedDetail(reply);
    if (detail) return { supported: false, active: false, detail };
    return { ...guardFromReply(reply), detail: null };
  }

  converge(desired: TunGuardVerb): Promise<TunGuardReconcileResult | undefined> {
    return new Promise<TunGuardReconcileResult | undefined>((resolve) => {
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
      let result: TunGuardReconcileResult | undefined;
      try {
        result = await this.invoke(job.verb);
      } catch {
        // invoke records operational failures; this guards programming errors.
      }
      for (const resolve of job.waiters) resolve(result);
    }
  }

  private async invoke(verb: TunGuardVerb): Promise<TunGuardReconcileResult> {
    return verb === "setup" ? this.setup() : this.teardown();
  }

  private unsupportedDetail(reply: HelperReply): string | null {
    if (reply.protocol < HELPER_PROTOCOL) return helperGuardUnsupportedWarning(reply);
    if (reply.protocol > HELPER_PROTOCOL)
      return `the TUN service speaks protocol ${reply.protocol}; this Sash needs ${HELPER_PROTOCOL}`;
    return null;
  }

  private async setup(): Promise<TunGuardReconcileResult> {
    try {
      const reply = await this.readHelperStatus();
      const unsupported = this.unsupportedDetail(reply);
      if (unsupported) {
        return this.record({ state: "unavailable", verb: "setup", detail: unsupported });
      }
      return this.record({ state: "ok", verb: "setup", detail: null });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const missing =
        code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES" || code === "EPERM";
      return this.record({
        state: missing ? "unavailable" : "failed",
        verb: "setup",
        detail: missing
          ? `the TUN service is unreachable; reinstall it: sash tun helper install (${errorMessage(error)})`
          : errorMessage(error),
      });
    }
  }

  private async teardown(): Promise<TunGuardReconcileResult> {
    try {
      await this.host.unguard();
      return this.record({ state: "ok", verb: "teardown", detail: null });
    } catch (error) {
      let state: TunGuardReconcileResult["state"] = "failed";
      let detail = errorMessage(error);
      try {
        const unsupported = this.unsupportedDetail(await this.readHelperStatus());
        if (unsupported) {
          state = "unavailable";
          detail = unsupported;
        }
      } catch {
        // The original unguard error is the actionable failure.
      }
      return this.record({ state, verb: "teardown", detail });
    }
  }

  private record(result: Omit<TunGuardReconcileResult, "at">): TunGuardReconcileResult {
    const recorded = { ...result, at: new Date().toISOString() };
    this.result = recorded;
    if (recorded.state === "ok") {
      this.lastWarnKey = undefined;
      return recorded;
    }
    const key = `${recorded.state}:${recorded.verb}:${recorded.detail ?? ""}`;
    if (key === this.lastWarnKey) return recorded;
    this.lastWarnKey = key;
    console.warn(
      `[sashd] TUN guard ${recorded.verb} ${recorded.state}: ${recorded.detail ?? "unknown error"}`,
    );
    return recorded;
  }
}

export function windowsTunGuard(
  host: WindowsGuardHost,
  deps: Omit<WindowsTunGuardDeps, "host"> = {},
): TunGuardLike {
  return new WindowsTunGuard({ ...deps, host });
}
