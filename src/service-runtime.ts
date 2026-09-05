import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ControllerEndpoint, CoreRuntime } from "./core-runtime.js";
import { errnoCode } from "./error-utils.js";
import { atomicWriteFileSync, durableRemoveFileSync } from "./fs-atomic.js";
import { isPlainObject } from "./json-shape.js";
import type { SashLayout } from "./paths.js";
import { buildSanitizedEnv, classifyProcessIdentity, killProcessGracefully } from "./process.js";
import { prepareServiceBundle } from "./service-bundle.js";
import type { ActiveServiceStatus, ServiceDiscoveryDeps } from "./service-client.js";
import {
  findServiceHelper,
  inspectService,
  parseServiceError,
  requireActiveService,
  serviceRequest,
} from "./service-client.js";
import type { SashSettings } from "./settings.js";
import type { CoreOwnershipSnapshot, CoreState } from "./supervisor.js";

export function parseBridgeReady(value: unknown): ControllerEndpoint {
  const error = parseServiceError(value);
  if (error) throw error;
  if (
    !isPlainObject(value) ||
    value.protocol !== 1 ||
    typeof value.controller !== "string" ||
    typeof value.secret !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.secret)
  )
    throw new Error("Invalid service bridge ready line");
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value.controller);
  if (!match || Number(match[1]) > 65535)
    throw new Error("Service bridge must use a normalized loopback endpoint");
  return { controller: value.controller, secret: value.secret };
}
export interface ServiceBridge {
  endpoint: ControllerEndpoint;
  close(): Promise<void>;
}
export interface BridgeOptions {
  spawn?: (helper: string, args: string[]) => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
}
export async function openServiceBridge(
  helper: string,
  layout: SashLayout,
  options: BridgeOptions = {},
): Promise<ServiceBridge> {
  const child = (
    options.spawn ??
    ((exe, args) =>
      spawn(exe, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: buildSanitizedEnv(),
      }))
  )(helper, ["bridge", "--root", fs.realpathSync(layout.root)]);
  let stderr = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]).subarray(-16384);
  });
  // Errors after readiness are observed through status requests, not uncaught events.
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 1500);
        function done() {
          clearTimeout(timer);
          child.off("exit", done);
          resolve();
        }
        child.once("exit", done);
      });
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      const stopped = await killProcessGracefully(child.pid, {
        timeoutMs: 3000,
        verify: () =>
          child.exitCode === null && child.signalCode === null && child.pid
            ? classifyProcessIdentity(child.pid, helper)
            : "mismatch",
      });
      if (!stopped) throw new Error("Cannot verify service bridge termination");
    })());
  try {
    const endpoint = await new Promise<ControllerEndpoint>((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      let ready = false;
      let failed = false;
      const timer = setTimeout(
        () => fail(new Error("Service bridge readiness timed out")),
        options.timeoutMs ?? 15000,
      );
      function fail(error: Error) {
        failed = true;
        clearTimeout(timer);
        reject(error);
      }
      child.once("error", fail);
      child.once("exit", () => {
        if (!ready)
          fail(
            new Error(
              `Service bridge exited before readiness${stderr.length ? "; diagnostics available on helper stderr" : ""}`,
            ),
          );
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (failed) return;
        if (ready) {
          if (chunk.length) void close().catch(() => {});
          return;
        }
        bytes = Buffer.concat([bytes, chunk]);
        const end = bytes.indexOf(10);
        if (bytes.length > 16384) {
          fail(new Error("Service bridge ready line exceeds 16 KiB"));
          return;
        }
        if (end < 0) return;
        try {
          if (end !== bytes.length - 1) throw new Error("Unexpected service bridge stdout");
          let value: unknown;
          try {
            value = JSON.parse(bytes.subarray(0, end).toString("utf8"));
          } catch {
            throw new Error("Invalid service bridge JSON");
          }
          const endpoint = parseBridgeReady(value);
          ready = true;
          clearTimeout(timer);
          resolve(endpoint);
        } catch (error) {
          fail(error instanceof Error ? error : new Error("Invalid service bridge JSON"));
        }
      });
    });
    return { endpoint, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Service bridge startup and cleanup failed");
    }
    throw error;
  }
}

interface SessionProof {
  session: string;
  serviceInstance: string;
  generation: number;
}
function sessionPath(layout: SashLayout): string {
  return path.join(layout.stateDir, "service-session.json");
}
export function readServiceSession(layout: SashLayout): SessionProof | undefined {
  const file = sessionPath(layout);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.size > 4096 ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw new Error("Unsafe service session file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let value: unknown;
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.size > 4096
    )
      throw new Error("Service session changed while opening");
    const bytes = Buffer.alloc(4097);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 4096) throw new Error("Service session exceeds size limit");
    try {
      value = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    } catch {
      throw new Error("Invalid service session JSON");
    }
  } finally {
    fs.closeSync(fd);
  }
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== 3 ||
    typeof value.session !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.session) ||
    typeof value.serviceInstance !== "string" ||
    !value.serviceInstance ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  )
    throw new Error("Invalid service session proof");
  return {
    session: value.session,
    serviceInstance: value.serviceInstance,
    generation: value.generation,
  };
}

export interface ServiceRuntimeDeps extends ServiceDiscoveryDeps {
  openBridge?: typeof openServiceBridge;
  request?: typeof serviceRequest;
  prepareBundle?: typeof prepareServiceBundle;
  monitorMs?: number;
  setRefreshTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearRefreshTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
let localGeneration = 0;
export class ServiceRuntime implements CoreRuntime {
  readonly backend = "service" as const;
  private proof: SessionProof | undefined;
  private observed: ActiveServiceStatus;
  private snapshot: CoreOwnershipSnapshot | undefined;
  private exitedSnapshot: CoreOwnershipSnapshot | undefined;
  private uncertain = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private monitoring = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshInterval: number | undefined;
  private refreshEpoch = 0;
  private readonly setRefreshTimer: NonNullable<ServiceRuntimeDeps["setRefreshTimer"]>;
  private readonly clearRefreshTimer: NonNullable<ServiceRuntimeDeps["clearRefreshTimer"]>;
  private lossReported = false;
  private lossCallback:
    | ((snapshot: CoreOwnershipSnapshot | undefined) => Promise<void>)
    | undefined;
  private readonly request: typeof serviceRequest;
  private readonly prepareBundle: typeof prepareServiceBundle;

  constructor(
    private readonly layout: SashLayout,
    private readonly settings: () => SashSettings,
    private readonly bridge: ServiceBridge,
    initial: ActiveServiceStatus,
    deps: ServiceRuntimeDeps = {},
  ) {
    this.observed = initial;
    this.setRefreshTimer = deps.setRefreshTimer ?? setTimeout;
    this.clearRefreshTimer = deps.clearRefreshTimer ?? clearTimeout;
    this.request = deps.request ?? serviceRequest;
    this.prepareBundle = deps.prepareBundle ?? prepareServiceBundle;
    this.proof = readServiceSession(layout);
    if (initial.core.running) {
      if (!this.proof || !this.matches(initial, this.proof))
        throw new Error("Active service Core has no matching private session proof");
      this.snapshot = {
        generation: ++localGeneration,
        pid: this.startResult(initial).pid,
      };
    }
    this.timer = setInterval(() => {
      if (this.monitoring || this.closed) return;
      this.monitoring = true;
      void this.serialized(async () => {
        // Capture identity when the queued observation actually begins, not
        // while an earlier start/restart may still be publishing its child.
        const original = this.ownedCoreSnapshot() ?? this.exitedSnapshot;
        try {
          await this.observe();
          return {
            original,
            lost:
              original !== undefined &&
              (!this.ownsCore(original) || this.observed.core.healthy === false),
          };
        } catch {
          return { original, lost: true };
        }
      })
        .then(({ original, lost }) => {
          if (lost) return this.reportLoss(original);
        })
        .catch(() => {})
        .finally(() => {
          this.monitoring = false;
        });
    }, deps.monitorMs ?? 2000);
    this.timer.unref();
  }
  get installed(): boolean {
    return true;
  }
  get coreVersion(): string | undefined {
    return this.observed.coreVersion;
  }
  controllerEndpoint(): ControllerEndpoint {
    return { ...this.bridge.endpoint };
  }
  onAvailabilityLoss(
    callback: (snapshot: CoreOwnershipSnapshot | undefined) => Promise<void>,
  ): void {
    this.lossCallback = callback;
  }
  private async reportLoss(original: CoreOwnershipSnapshot | undefined): Promise<void> {
    if (this.closed || this.lossReported) return;
    this.lossReported = true;
    await this.lossCallback?.(original);
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => {
      if (this.closed) throw new Error("Service runtime is closed");
      return operation();
    });
    this.queue = next.catch(() => {});
    return next;
  }
  private matches(status: ActiveServiceStatus, proof: SessionProof): boolean {
    return (
      status.serviceInstance === proof.serviceInstance && status.generation === proof.generation
    );
  }
  private async observe(fresh?: ActiveServiceStatus): Promise<ActiveServiceStatus> {
    try {
      const state =
        fresh ??
        requireActiveService(await this.request(this.bridge.endpoint, "status"), this.layout);
      if (
        state.serviceInstance !== this.observed.serviceInstance ||
        (this.proof && state.serviceInstance !== this.proof.serviceInstance)
      )
        throw new Error("Service boot identity changed");
      if (
        state.core.running &&
        this.observed.core.running &&
        (state.core.pid !== this.observed.core.pid ||
          state.core.startedAt !== this.observed.core.startedAt)
      )
        throw new Error("Service Core process identity changed");
      if (
        state.generation < this.observed.generation ||
        (this.observed.core.running &&
          !state.core.running &&
          state.generation !== this.observed.generation + 1)
      )
        throw new Error("Service Core generation regressed or exit was not identified");
      if (state.core.running && (!this.proof || !this.matches(state, this.proof)))
        throw new Error("Service Core ownership changed");
      if (
        this.proof &&
        !state.core.running &&
        state.generation !== this.proof.generation &&
        state.generation !== this.proof.generation + 1 &&
        state.generation !== this.proof.generation - 1
      )
        throw new Error("Stopped service generation does not match session proof");
      this.observed = state;
      this.uncertain = false;
      if (!state.core.running) {
        // A foreground status query can confirm exit before the monitor runs.
        // Retain its identity for loss notification, not termination authority.
        this.exitedSnapshot ??= this.snapshot;
        this.snapshot = undefined;
      } else if (!this.snapshot)
        this.snapshot = {
          generation: ++localGeneration,
          pid: this.startResult(state).pid,
        };
      if (state.core.running && state.core.healthy) this.lossReported = false;
      return state;
    } catch (error) {
      this.uncertain = true;
      throw error;
    }
  }
  status(): Promise<CoreState> {
    return this.serialized(async () => ({ ...(await this.observe()).core }));
  }
  isRunning(): boolean {
    return this.uncertain || this.observed.core.running;
  }
  ownedCoreSnapshot(): CoreOwnershipSnapshot | undefined {
    return this.snapshot ? { ...this.snapshot } : undefined;
  }
  ownsCore(snapshot: CoreOwnershipSnapshot): boolean {
    return (
      !!this.snapshot &&
      this.snapshot.generation === snapshot.generation &&
      this.snapshot.pid === snapshot.pid
    );
  }
  start(): Promise<{ pid: number; version?: string; tunActive?: boolean }> {
    return this.serialized(async () => {
      const current = await this.observe();
      if (current.core.running) return this.startResult(current);
      if (this.proof)
        throw new Error("Recover the previous service session before starting a new Core");
      const bundle = await this.prepareBundle(
        fs.readFileSync(this.layout.configFile, "utf8"),
        this.layout,
      );
      const desiredTun = this.settings().tun;
      this.proof = {
        session: randomBytes(32).toString("hex"),
        serviceInstance: current.serviceInstance,
        generation: current.generation + 1,
      };
      atomicWriteFileSync(sessionPath(this.layout), JSON.stringify(this.proof));
      this.uncertain = true;
      const state = requireActiveService(
        await this.request(this.bridge.endpoint, "start", {
          session: this.proof.session,
          bundle,
        }),
        this.layout,
      );
      if (
        !this.matches(state, this.proof) ||
        !state.core.running ||
        !state.core.healthy ||
        state.core.tunActive !== desiredTun
      )
        throw new Error("Service start returned an unexpected Core identity");
      this.observed = state;
      this.uncertain = false;
      this.snapshot = {
        generation: ++localGeneration,
        pid: this.startResult(state).pid,
      };
      this.exitedSnapshot = undefined;
      this.lossReported = false;
      this.scheduleRefresh(bundle.refreshMs);
      return this.startResult(state);
    });
  }
  private startResult(state: ActiveServiceStatus): {
    pid: number;
    version?: string;
    tunActive?: boolean;
  } {
    if (!state.core.running || state.core.pid === undefined)
      throw new Error("Service Core is not running");
    return {
      pid: state.core.pid,
      ...(state.core.version === undefined ? {} : { version: state.core.version }),
      ...(state.core.tunActive === undefined ? {} : { tunActive: state.core.tunActive }),
    };
  }
  stop(): Promise<void> {
    this.refreshEpoch++;
    this.scheduleRefresh(undefined);
    return this.serialized(async () => {
      // Explicit stop is the only live-adapter boundary allowed to acknowledge
      // a recovered idle host. Polling must continue reporting boot loss.
      this.uncertain = true;
      const fresh = requireActiveService(
        await this.request(this.bridge.endpoint, "status"),
        this.layout,
      );
      if (
        fresh.serviceInstance !== this.observed.serviceInstance ||
        (this.proof && fresh.serviceInstance !== this.proof.serviceInstance)
      ) {
        if (fresh.core.running) throw new Error("Service boot identity changed");
        const persisted = readServiceSession(this.layout);
        if (JSON.stringify(persisted) !== JSON.stringify(this.proof))
          throw new Error("Service session proof changed before stop");
        durableRemoveFileSync(sessionPath(this.layout));
        this.proof = undefined;
        this.observed = fresh;
        this.snapshot = undefined;
        this.exitedSnapshot = undefined;
        this.uncertain = false;
        return;
      }
      const current = await this.observe(fresh);
      if (!this.proof) {
        if (current.core.running) throw new Error("Missing service session proof");
        return;
      }
      // A failed start can leave the original stopped generation: no launch
      // occurred, so the boot/generation observation proves there is no child.
      if (current.core.running || current.generation !== this.proof.generation - 1) {
        this.uncertain = true;
        const stopped = requireActiveService(
          await this.request(this.bridge.endpoint, "stop", this.proof),
          this.layout,
        );
        if (
          stopped.core.running ||
          stopped.serviceInstance !== this.proof.serviceInstance ||
          (stopped.generation !== this.proof.generation &&
            stopped.generation !== this.proof.generation + 1)
        )
          throw new Error("Service stop did not confirm owned Core termination");
        this.observed = stopped;
      }
      durableRemoveFileSync(sessionPath(this.layout));
      this.proof = undefined;
      this.snapshot = undefined;
      this.exitedSnapshot = undefined;
      this.uncertain = false;
    });
  }
  async restart(): Promise<{
    pid: number;
    version?: string;
    tunActive?: boolean;
  }> {
    await this.stop();
    return this.start();
  }
  validateConfig(yaml: string): Promise<void> {
    return this.serialized(async () => {
      await this.observe();
      await this.request(this.bridge.endpoint, "validate", {
        bundle: await this.prepareBundle(yaml, this.layout),
      });
    });
  }
  reloadConfig(configPath: string): Promise<void> {
    const epoch = ++this.refreshEpoch;
    return this.serialized(async () => {
      const state = await this.observe();
      if (!state.core.running || !this.proof) throw new Error("No owned service Core to reload");
      const bundle = await this.prepareBundle(fs.readFileSync(configPath, "utf8"), this.layout);
      if (this.closed || epoch !== this.refreshEpoch)
        throw new Error("Service reload was superseded");
      this.uncertain = true;
      const next = requireActiveService(
        await this.request(this.bridge.endpoint, "reload", {
          ...this.proof,
          bundle,
        }),
        this.layout,
      );
      if (!this.matches(next, this.proof) || !next.core.running || !next.core.healthy)
        throw new Error("Service reload changed Core identity");
      this.observed = next;
      this.uncertain = false;
      this.scheduleRefresh(bundle.refreshMs);
    });
  }
  private scheduleRefresh(interval: number | undefined): void {
    if (this.refreshTimer) this.clearRefreshTimer(this.refreshTimer);
    this.refreshTimer = undefined;
    this.refreshInterval = interval;
    if (interval === undefined || this.closed) return;
    this.refreshTimer = this.setRefreshTimer(
      () => {
        this.refreshTimer = undefined;
        void this.refreshProviders().catch(() => {});
      },
      Math.max(1000, Math.min(interval, 86_400_000)),
    );
    this.refreshTimer.unref();
  }
  /** Re-fetch the fixed user config's providers; native reload remains the final policy boundary. */
  refreshProviders(): Promise<void> {
    const epoch = this.refreshEpoch;
    const original = this.ownedCoreSnapshot();
    return this.serialized(async () => {
      if (!original || !this.ownsCore(original) || epoch !== this.refreshEpoch)
        throw new Error("No current owned service Core to refresh");
      const interval = this.refreshInterval;
      this.scheduleRefresh(undefined);
      try {
        await this.observe();
        if (!this.proof) throw new Error("Missing service session proof");
        const proof = { ...this.proof };
        const bundle = await this.prepareBundle(
          fs.readFileSync(this.layout.configFile, "utf8"),
          this.layout,
        );
        if (this.closed || epoch !== this.refreshEpoch || !this.ownsCore(original))
          throw new Error("Service provider refresh was superseded");
        const current = await this.observe();
        if (this.closed || epoch !== this.refreshEpoch || !this.ownsCore(original))
          throw new Error("Service provider refresh was superseded");
        if (!current.core.running || !this.matches(current, proof))
          throw new Error("Service provider refresh ownership changed");
        const next = requireActiveService(
          await this.request(this.bridge.endpoint, "reload", {
            ...proof,
            bundle,
          }),
          this.layout,
        );
        if (!this.matches(next, proof) || !next.core.running || !next.core.healthy)
          throw new Error("Service provider refresh changed Core identity");
        this.observed = next;
        this.uncertain = false;
        if (epoch === this.refreshEpoch) this.scheduleRefresh(bundle.refreshMs);
      } catch (error) {
        // Failed fetch/publication leaves the existing runtime and proof intact.
        if (!this.closed && epoch === this.refreshEpoch) this.scheduleRefresh(interval);
        throw error;
      }
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.refreshEpoch++;
    this.scheduleRefresh(undefined);
    clearInterval(this.timer);
    this.timer = undefined;
    await this.queue;
    await this.bridge.close();
  }
}
async function connectServiceRuntime(
  layout: SashLayout,
  settings: () => SashSettings,
  deps: ServiceRuntimeDeps,
  startupRecovery: boolean,
): Promise<ServiceRuntime | undefined> {
  if ((deps.platform ?? process.platform) !== "win32") return undefined;
  const helper = (deps.findHelper ?? findServiceHelper)();
  const status = await inspectService(layout, {
    ...deps,
    findHelper: () => helper,
  });
  if (status.supported && status.installed === false) return undefined;
  requireActiveService(status, layout);
  if (!helper) throw new Error("Installed service helper is missing");
  const bridge = await (deps.openBridge ?? openServiceBridge)(helper, layout);
  try {
    const initial = requireActiveService(
      await (deps.request ?? serviceRequest)(bridge.endpoint, "status"),
      layout,
    );
    // Connection setup retires a previous boot's proof only for startup recovery.
    // Both discovery and this authenticated fresh observation passed the native
    // root/protocol/service checks; an active or unqueryable Core never qualifies.
    if (startupRecovery) {
      const proof = readServiceSession(layout);
      if (proof && proof.serviceInstance !== initial.serviceInstance && !initial.core.running)
        durableRemoveFileSync(sessionPath(layout));
    }
    return new ServiceRuntime(layout, settings, bridge, initial, deps);
  } catch (error) {
    await bridge.close();
    throw error;
  }
}
export function createServiceRuntime(
  layout: SashLayout,
  settings: () => SashSettings,
  deps: ServiceRuntimeDeps = {},
): Promise<ServiceRuntime | undefined> {
  return connectServiceRuntime(layout, settings, deps, false);
}
/** Caller must release its system-proxy ownership before invoking recovery. */
export async function recoverServiceRuntime(
  layout: SashLayout,
  settings: SashSettings | (() => SashSettings),
  deps: ServiceRuntimeDeps = {},
): Promise<boolean> {
  const runtime = await connectServiceRuntime(
    layout,
    typeof settings === "function" ? settings : () => settings,
    deps,
    true,
  );
  if (!runtime) return false;
  try {
    await runtime.stop();
    return true;
  } finally {
    await runtime.close();
  }
}
