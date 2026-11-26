import { existsSync } from "node:fs";
import { errorMessage } from "./error-utils.js";
import { buildSanitizedEnv, findExecutableOnPath, runSanitizedCommandAsync } from "./process.js";

export const TUN_GUARD_PATH = "/usr/local/libexec/sash-tun-guard";
export const TUN_GUARD_DEVICE_PATTERN = /^[a-zA-Z0-9._-]{1,32}$/;
export const LINUX_DEFAULT_TUN_DEVICE = "Meta";
export const MIHOMO_ROUTE_TABLE = "2022";
export const MIHOMO_DNS_SERVER = "198.18.0.2";

export type TunGuardVerb = "setup" | "teardown";

export interface TunGuardReconcileResult {
  state: "ok" | "failed" | "unavailable";
  verb: TunGuardVerb;
  detail: string | null;
  at: string;
}

export interface TunGuardObservation {
  supported: boolean;
  active: boolean;
  device?: string;
  interfaceIndex?: number;
  detail: string | null;
}

/**
 * The lifecycle only ever converges the guard; callers may fire-and-forget
 * the promise or await it — it never rejects. A convergence resolves with the
 * invocation that actually ran, which may carry a verb requested after this
 * call because queued calls coalesce to the latest desired state.
 */
export interface TunGuardLike {
  readonly supported: boolean;
  converge(
    desired: TunGuardVerb,
    options?: { device?: string },
  ): Promise<TunGuardReconcileResult | undefined>;
  /** Cached convergence result for polling status; performs no I/O. */
  lastResult(): TunGuardReconcileResult | undefined;
  /** Fresh guard observation for interactive checks; performs I/O when supported. */
  readFreshStatus?(): Promise<TunGuardObservation>;
}

export type TunGuardRunner = (
  cmd: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<string>;

const defaultRunner: TunGuardRunner = (cmd, args, { timeoutMs }) =>
  runSanitizedCommandAsync(cmd, args, {
    timeoutMs,
    maxBuffer: 256 * 1024,
    stderrInError: true,
  });

export interface TunGuardDeps {
  platform?: NodeJS.Platform | string;
  run?: TunGuardRunner;
  scriptPath?: string;
  env?: NodeJS.ProcessEnv;
  asRoot?: boolean;
  probeTtlMs?: number;
  now?: () => number;
}

type ProbeOutcome =
  | { available: true }
  | { available: false; reason: "no-script" | "no-sudo" | "not-authorized"; detail: string };

const PROBE_TTL_MS = 30_000;
const SETUP_TIMEOUT_MS = 75_000;
const TEARDOWN_TIMEOUT_MS = 40_000;

interface QueuedReconcile {
  verb: TunGuardVerb;
  device: string | undefined;
  waiters: Array<(result: TunGuardReconcileResult | undefined) => void>;
}

/**
 * Daemon-side caller for the privileged guard script installed by
 * `sash tun helper install`. Reconciles are serialized and coalesced: at most
 * one invocation is in flight, and calls arriving while one runs merge into a
 * single trailing invocation carrying the latest desired state.
 */
export class TunGuard implements TunGuardLike {
  private readonly platform: string;
  private readonly run: TunGuardRunner;
  private readonly scriptPath: string;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly asRoot: boolean;
  private readonly probeTtlMs: number;
  private readonly now: () => number;
  private draining: Promise<void> | undefined;
  private queued: QueuedReconcile | undefined;
  private result: TunGuardReconcileResult | undefined;
  private probeCache: { at: number; outcome: ProbeOutcome } | undefined;
  private lastWarnKey: string | undefined;

  constructor(deps: TunGuardDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.run = deps.run ?? defaultRunner;
    this.scriptPath = deps.scriptPath ?? TUN_GUARD_PATH;
    this.env = deps.env;
    this.asRoot = deps.asRoot ?? process.geteuid?.() === 0;
    this.probeTtlMs = deps.probeTtlMs ?? PROBE_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  get supported(): boolean {
    return this.platform === "linux" || this.platform === "darwin";
  }

  lastResult(): TunGuardReconcileResult | undefined {
    return this.result;
  }

  converge(
    desired: TunGuardVerb,
    options: { device?: string } = {},
  ): Promise<TunGuardReconcileResult | undefined> {
    if (!this.supported) return Promise.resolve(undefined);
    const device = this.effectiveDevice(options.device);
    return new Promise<TunGuardReconcileResult | undefined>((resolve) => {
      if (this.queued) {
        this.queued.verb = desired;
        this.queued.device = device;
        this.queued.waiters.push(resolve);
      } else {
        this.queued = { verb: desired, device, waiters: [resolve] };
      }
      if (!this.draining) this.draining = this.drain();
    });
  }

  private effectiveDevice(configured: string | undefined): string | undefined {
    if (this.platform === "linux") return configured ?? LINUX_DEFAULT_TUN_DEVICE;
    return undefined;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const job = this.queued;
      if (!job) {
        // Clear synchronously with the empty-queue check: a waiter continuation
        // can enqueue the next convergence before a .finally callback would run.
        this.draining = undefined;
        return;
      }
      this.queued = undefined;
      let result: TunGuardReconcileResult | undefined;
      try {
        result = await this.invoke(job.verb, job.device);
      } catch {
        // invoke swallows convergence failures; this guards programming errors.
      }
      for (const resolve of job.waiters) resolve(result);
    }
  }

  private guardArgs(verb: TunGuardVerb, device: string | undefined): string[] | undefined {
    if (verb === "teardown") return ["teardown"];
    if (device === undefined) return ["setup"];
    if (!TUN_GUARD_DEVICE_PATTERN.test(device)) return undefined;
    return ["setup", device];
  }

  private async invoke(
    verb: TunGuardVerb,
    device: string | undefined,
  ): Promise<TunGuardReconcileResult | undefined> {
    const guardArgs = this.guardArgs(verb, device);
    if (!guardArgs) {
      return this.record({
        state: "failed",
        verb,
        detail: `refusing invalid TUN device name ${JSON.stringify(device)}`,
      });
    }
    const probe = await this.probe();
    if (!probe.available) {
      // Nothing was ever installed, so nothing needs undoing: a teardown for a
      // missing script is already converged, not a failure worth logging.
      if (verb === "teardown" && probe.reason === "no-script") return undefined;
      return this.record({ state: "unavailable", verb, detail: probe.detail });
    }
    const timeoutMs = verb === "setup" ? SETUP_TIMEOUT_MS : TEARDOWN_TIMEOUT_MS;
    try {
      if (this.asRoot) {
        await this.run(this.scriptPath, guardArgs, { timeoutMs });
      } else {
        const sudo = this.resolveSudo();
        if (!sudo) {
          return this.record({ state: "unavailable", verb, detail: "sudo is not installed" });
        }
        await this.run(sudo, ["-n", this.scriptPath, ...guardArgs], { timeoutMs });
      }
      return this.record({ state: "ok", verb, detail: null });
    } catch (error) {
      return this.record({ state: "failed", verb, detail: errorMessage(error) });
    }
  }

  private resolveSudo(): string | undefined {
    const env = this.env ?? buildSanitizedEnv();
    return (
      findExecutableOnPath("sudo", env) ??
      ["/usr/bin/sudo", "/bin/sudo"].find((candidate) => existsSync(candidate))
    );
  }

  private async probe(): Promise<ProbeOutcome> {
    if (!existsSync(this.scriptPath)) {
      return {
        available: false,
        reason: "no-script",
        detail: "the guard script is not installed; rerun sash tun helper install",
      };
    }
    if (this.asRoot) return { available: true };
    const sudo = this.resolveSudo();
    if (!sudo) {
      return { available: false, reason: "no-sudo", detail: "sudo is not installed" };
    }
    const cached = this.probeCache;
    if (cached && this.now() - cached.at < this.probeTtlMs) return cached.outcome;
    let outcome: ProbeOutcome;
    try {
      await this.run(sudo, ["-n", "-l", this.scriptPath], { timeoutMs: 5_000 });
      outcome = { available: true };
    } catch {
      outcome = {
        available: false,
        reason: "not-authorized",
        detail:
          "passwordless sudo for the guard script is not granted; rerun sash tun helper install",
      };
    }
    this.probeCache = { at: this.now(), outcome };
    return outcome;
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

export function noopTunGuard(): TunGuardLike {
  return {
    supported: false,
    converge: async () => undefined,
    lastResult: () => undefined,
  };
}

export type TunNetworkAspect =
  | "blackhole4"
  | "blackhole6"
  | "resolved"
  | "pf-attachment"
  | "pf-anchor"
  | "pf-enabled";

export interface TunNetworkObservation {
  aspect: TunNetworkAspect;
  state: "ok" | "failed" | "unknown";
  detail: string;
}

export interface InspectTunNetworkOptions {
  device?: string;
  platform?: NodeJS.Platform | string;
  run?: TunGuardRunner;
}

function tableHasBlackhole(output: string): boolean {
  return /(^|\n)\s*blackhole\s+default(\s|$)/.test(output);
}

async function blackhole4Observation(run: TunGuardRunner): Promise<TunNetworkObservation> {
  try {
    const output = await run("ip", ["route", "show", "table", MIHOMO_ROUTE_TABLE], {
      timeoutMs: 5_000,
    });
    return tableHasBlackhole(output)
      ? {
          aspect: "blackhole4",
          state: "ok",
          detail: `blackhole fallback is installed in table ${MIHOMO_ROUTE_TABLE}`,
        }
      : {
          aspect: "blackhole4",
          state: "failed",
          detail: `no blackhole route in table ${MIHOMO_ROUTE_TABLE}; a killed TUN Core falls back to a direct connection`,
        };
  } catch (error) {
    return {
      aspect: "blackhole4",
      state: "unknown",
      detail: `could not read table ${MIHOMO_ROUTE_TABLE}: ${errorMessage(error)}`,
    };
  }
}

/**
 * IPv6 blackhole absence only matters when the host routes IPv6 at all; an
 * IPv6-inactive host cannot leak over IPv6, so the observation is skipped.
 */
async function blackhole6Observation(
  run: TunGuardRunner,
): Promise<TunNetworkObservation | undefined> {
  try {
    const table = await run("ip", ["-6", "route", "show", "table", MIHOMO_ROUTE_TABLE], {
      timeoutMs: 5_000,
    });
    if (tableHasBlackhole(table)) {
      return {
        aspect: "blackhole6",
        state: "ok",
        detail: `blackhole fallback is installed in table ${MIHOMO_ROUTE_TABLE}`,
      };
    }
    const main = await run("ip", ["-6", "route", "show"], { timeoutMs: 5_000 });
    if (!main.trim()) return undefined;
    return {
      aspect: "blackhole6",
      state: "failed",
      detail: `no IPv6 blackhole route in table ${MIHOMO_ROUTE_TABLE}; a killed TUN Core leaks IPv6 directly`,
    };
  } catch {
    return undefined;
  }
}

async function resolvedObservation(
  run: TunGuardRunner,
  device: string,
): Promise<TunNetworkObservation | undefined> {
  try {
    await run("systemctl", ["is-active", "--quiet", "systemd-resolved"], { timeoutMs: 5_000 });
  } catch {
    return undefined;
  }
  try {
    const status = await run("resolvectl", ["status", device], { timeoutMs: 5_000 });
    const hasDns = status.includes(MIHOMO_DNS_SERVER);
    const hasDomain = status.split("\n").some((line) => line.includes("~."));
    return hasDns && hasDomain
      ? {
          aspect: "resolved",
          state: "ok",
          detail: `systemd-resolved routes DNS through ${device}`,
        }
      : {
          aspect: "resolved",
          state: "failed",
          detail: `systemd-resolved is not bound to ${device}; DNS queries bypass the tunnel and fake-ip does not answer`,
        };
  } catch (error) {
    return {
      aspect: "resolved",
      state: "unknown",
      detail: `could not read the resolved state of ${device}: ${errorMessage(error)}`,
    };
  }
}

/**
 * Unprivileged Linux network-state inspection for doctor: the blackhole
 * fallback routes that keep a killed Core fail-closed, and the resolved
 * integration fake-ip relies on. Empty on other platforms.
 */
export async function inspectLinuxTunNetwork(
  options: InspectTunNetworkOptions = {},
): Promise<TunNetworkObservation[]> {
  if ((options.platform ?? process.platform) !== "linux") return [];
  const run = options.run ?? defaultRunner;
  const device = options.device ?? LINUX_DEFAULT_TUN_DEVICE;
  const [v4, v6, resolved] = await Promise.all([
    blackhole4Observation(run),
    blackhole6Observation(run),
    resolvedObservation(run, device),
  ]);
  return [v4, ...(v6 ? [v6] : []), ...(resolved ? [resolved] : [])];
}

export interface MacosTunGuardStatus {
  main?: string;
  anchor?: string;
  rules?: number;
  pf?: string;
  pfReference?: string;
}

export function parseMacosTunGuardStatus(output: string): MacosTunGuardStatus {
  const status: MacosTunGuardStatus = {};
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key === "main") status.main = value;
    if (key === "anchor") status.anchor = value;
    if (key === "rules" && /^\d+$/.test(value)) status.rules = Number(value);
    if (key === "pf") status.pf = value;
    if (key === "pf-reference") status.pfReference = value;
  }
  return status;
}

export interface InspectMacosTunNetworkOptions {
  platform?: NodeJS.Platform | string;
  run?: TunGuardRunner;
  scriptPath?: string;
  asRoot?: boolean;
}

export async function inspectMacosTunNetwork(
  options: InspectMacosTunNetworkOptions = {},
): Promise<TunNetworkObservation[]> {
  if ((options.platform ?? process.platform) !== "darwin") return [];
  const run = options.run ?? defaultRunner;
  const scriptPath = options.scriptPath ?? TUN_GUARD_PATH;
  const asRoot = options.asRoot ?? process.geteuid?.() === 0;
  if (!existsSync(scriptPath)) {
    return [
      {
        aspect: "pf-anchor",
        state: "failed",
        detail: "the guard script is not installed; TUN traffic is not fail-closed",
      },
    ];
  }
  let output: string;
  try {
    output = asRoot
      ? await run(scriptPath, ["status"], { timeoutMs: 5_000 })
      : await run("/usr/bin/sudo", ["-n", scriptPath, "status"], { timeoutMs: 5_000 });
  } catch (error) {
    return [
      {
        aspect: "pf-anchor",
        state: "unknown",
        detail: `could not read the pf guard state: ${errorMessage(error)}`,
      },
    ];
  }
  const status = parseMacosTunGuardStatus(output);
  return [
    status.main === "attached"
      ? {
          aspect: "pf-attachment",
          state: "ok",
          detail: "the Sash pf anchor is attached to the main ruleset",
        }
      : {
          aspect: "pf-attachment",
          state: "failed",
          detail: `the Sash pf anchor is not attached to the main ruleset (${status.main ?? "unknown"})`,
        },
    status.anchor === "loaded" && (status.rules ?? 0) > 0
      ? {
          aspect: "pf-anchor",
          state: "ok",
          detail: `the Sash pf anchor is loaded with ${status.rules} rules`,
        }
      : {
          aspect: "pf-anchor",
          state: "failed",
          detail: `the Sash pf anchor is not loaded (${status.anchor ?? "unknown"}, ${status.rules ?? 0} rules); a killed TUN Core falls back to a direct connection`,
        },
    status.pf === "enabled"
      ? { aspect: "pf-enabled", state: "ok", detail: "pf is enabled" }
      : {
          aspect: "pf-enabled",
          state: "failed",
          detail: `pf is not enabled (${status.pf ?? "unknown"}); the Sash anchor cannot filter traffic`,
        },
  ];
}

export async function inspectTunNetwork(
  options: InspectTunNetworkOptions & InspectMacosTunNetworkOptions = {},
): Promise<TunNetworkObservation[]> {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return inspectMacosTunNetwork(options);
  return inspectLinuxTunNetwork(options);
}
