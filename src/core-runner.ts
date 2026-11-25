import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CoreEngine } from "./engine/index.js";
import { errorMessage } from "./error-utils.js";
import type { SashLayout } from "./paths.js";
import type { ProcessIdentity, ProcessIdentityVerifier } from "./process.js";
import {
  buildSanitizedEnv,
  classifyProcessIdentityAsync,
  clearPidRecord,
  isProcessAlive,
  killProcessGracefully,
  readPidRecord,
  withPrivateAppendLogFds,
  writePidRecord,
} from "./process.js";
import type { SashSettings } from "./settings.js";
import type { HostedCore } from "./tun-service.js";

export interface CoreExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The Core was already asked to stop, so the exit is not a surprise. */
  requested: boolean;
}

export interface StartAbort {
  error: Error;
  /** False when the Core may still be running; its session must then be kept. */
  ended: boolean;
}

/** One launched Core, from launch until it ends or is released. */
export interface RunningCore {
  readonly pid: number;
  readonly startedAt: string;
  isAlive(): boolean;
  onExit(listener: (exit: CoreExit) => void): void;
  /** Rejects while the controller is awaited when the Core is gone or its launch failed. */
  checkStarting(): Promise<void>;
  startupSucceeded(): void;
  /** Ends a Core whose startup failed and words the failure for its launch path. */
  abortStart(failure: unknown, errorLogTail: () => string): Promise<StartAbort>;
  /** Rejects when the Core could not be confirmed stopped. */
  stop(): Promise<void>;
  release(): void;
}

export interface CoreRunner {
  launch(settings: SashSettings): Promise<RunningCore>;
  /** Ends whatever a previous Sash instance left running through this runner. */
  reclaimStale(): Promise<void>;
}

function recentErrors(errorLogTail: string): string {
  return errorLogTail ? `\nRecent errors:\n${errorLogTail}` : "";
}

function exitedDuringStartup(errorLogTail: () => string): StartAbort {
  return {
    ended: true,
    error: new Error(`Core exited during startup.${recentErrors(errorLogTail())}`),
  };
}

function managedPathsMatch(leftPath: string, rightPath: string): boolean {
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function spawnCore(engine: CoreEngine, layout: SashLayout): ChildProcess {
  return withPrivateAppendLogFds(
    layout.coreLogFile,
    layout.coreErrLogFile,
    ({ stdoutFd, stderrFd }) =>
      spawn(layout.coreExe, engine.spawnArguments(layout), {
        cwd: layout.root,
        stdio: ["ignore", stdoutFd, stderrFd],
        windowsHide: true,
        env: buildSanitizedEnv(),
      }),
  );
}

export interface SpawnedCoreRunnerOptions {
  layout: SashLayout;
  engine: CoreEngine;
  spawnFn?: (layout: SashLayout, settings: SashSettings) => ChildProcess;
  isAliveFn?: typeof isProcessAlive;
  killFn?: typeof killProcessGracefully;
  classifyIdentityFn?: ProcessIdentityVerifier;
}

interface ProcessControl {
  layout: SashLayout;
  isAlive: typeof isProcessAlive;
  kill: typeof killProcessGracefully;
  classifyIdentity: ProcessIdentityVerifier;
}

class SpawnedCore implements RunningCore {
  readonly startedAt = new Date().toISOString();
  private persistFailure: Error | undefined;
  private ownsPidRecord = false;
  private stopRequested = false;
  private ended = false;
  private exitListener: ((exit: CoreExit) => void) | undefined;

  constructor(
    private readonly control: ProcessControl,
    private readonly child: ChildProcess,
    readonly pid: number,
    private readonly spawnFailure: () => Error | undefined,
  ) {
    child.once("exit", (code, signal) => {
      this.ended = true;
      this.exitListener?.({ code, signal, requested: this.stopRequested });
    });
  }

  recordOwnership(): void {
    try {
      writePidRecord(this.control.layout.pidFile, {
        pid: this.pid,
        exe: this.control.layout.coreExe,
        startedAt: this.startedAt,
      });
      this.ownsPidRecord = true;
    } catch (error) {
      this.persistFailure = error instanceof Error ? error : new Error(String(error));
    }
  }

  isAlive(): boolean {
    return this.control.isAlive(this.pid);
  }

  onExit(listener: (exit: CoreExit) => void): void {
    this.exitListener = listener;
  }

  async checkStarting(): Promise<void> {
    const launchFailure = this.persistFailure ?? this.spawnFailure();
    if (launchFailure) throw launchFailure;
    if (!this.isAlive()) throw new Error("Core exited during startup");
  }

  startupSucceeded(): void {}

  async abortStart(failure: unknown, errorLogTail: () => string): Promise<StartAbort> {
    const persistFailed = failure === this.persistFailure;
    const spawnFailed = failure === this.spawnFailure();
    if (!persistFailed && !spawnFailed && !this.isAlive()) return exitedDuringStartup(errorLogTail);
    const ended = await this.terminate(3000);
    const unconfirmed = ended ? "" : `; process ${this.pid} could not be confirmed stopped`;
    const message = errorMessage(failure);
    if (persistFailed)
      return {
        ended,
        error: new Error(`Failed to persist Core PID ownership: ${message}${unconfirmed}`),
      };
    if (spawnFailed) {
      const tail = errorLogTail();
      return {
        ended,
        error: new Error(
          `Failed to start core: ${message}${unconfirmed}${tail ? `\n${tail}` : ""}`,
        ),
      };
    }
    const preserved = ended
      ? ""
      : " The process could not be confirmed stopped; PID state was preserved.";
    return {
      ended,
      error: new Error(`${message}${preserved}${recentErrors(errorLogTail())}`),
    };
  }

  async stop(): Promise<void> {
    if (!this.isAlive()) return;
    if (!(await this.terminate(8000)))
      throw new Error("Core process is still running after termination attempt");
  }

  // Only the Core that wrote the PID record may clear it: a later Core's
  // record must survive this one's late exit.
  release(): void {
    this.ended = true;
    if (!this.ownsPidRecord) return;
    this.ownsPidRecord = false;
    clearPidRecord(this.control.layout.pidFile);
  }

  private terminate(timeoutMs: number): Promise<boolean> {
    this.stopRequested = true;
    return this.control.kill(this.pid, { timeoutMs, verify: () => this.identity() });
  }

  private async identity(): Promise<ProcessIdentity> {
    const { child } = this;
    if (this.ended) return "mismatch";
    if (child.exitCode !== null && child.exitCode !== undefined) return "mismatch";
    if (child.signalCode !== null && child.signalCode !== undefined) return "mismatch";
    if (!this.isAlive()) return "mismatch";
    const identity = await this.control.classifyIdentity(this.pid, this.control.layout.coreExe);
    return !this.ended && this.isAlive() ? identity : "mismatch";
  }
}

export class SpawnedCoreRunner implements CoreRunner {
  private readonly control: ProcessControl;
  private readonly spawnChild: (layout: SashLayout, settings: SashSettings) => ChildProcess;

  constructor(options: SpawnedCoreRunnerOptions) {
    this.control = {
      layout: options.layout,
      isAlive: options.isAliveFn ?? isProcessAlive,
      kill: options.killFn ?? killProcessGracefully,
      classifyIdentity: options.classifyIdentityFn ?? classifyProcessIdentityAsync,
    };
    this.spawnChild = options.spawnFn ?? ((layout) => spawnCore(options.engine, layout));
  }

  async launch(settings: SashSettings): Promise<RunningCore> {
    const child = this.spawnChild(this.control.layout, settings);
    // Attach the error listener before any early return: an asynchronous
    // spawn failure must never surface as an unhandled "error" event.
    let spawnFailure: Error | undefined;
    child.on("error", (error) => {
      spawnFailure = error;
    });
    if (!child.pid) throw new Error("Failed to start core process (no PID returned)");
    const core = new SpawnedCore(this.control, child, child.pid, () => spawnFailure);
    core.recordOwnership();
    return core;
  }

  async reclaimStale(): Promise<void> {
    const { layout, isAlive, kill, classifyIdentity } = this.control;
    const record = readPidRecord(layout.pidFile);
    if (!record) {
      if (fs.existsSync(layout.pidFile)) {
        throw new Error(`Core PID record is corrupt: ${layout.pidFile}`);
      }
      return;
    }

    if (!managedPathsMatch(record.exe, layout.coreExe)) {
      throw new Error(`Core PID record executable does not match the managed path: ${record.exe}`);
    }
    if (!isAlive(record.pid)) {
      clearPidRecord(layout.pidFile);
      return;
    }

    const identity = await classifyIdentity(record.pid, layout.coreExe);
    if (identity === "mismatch") {
      clearPidRecord(layout.pidFile);
      return;
    }
    if (identity === "unknown") {
      throw new Error(
        `Refusing to terminate stale Core PID ${record.pid}: process identity could not be verified`,
      );
    }

    const terminated = await kill(record.pid, {
      timeoutMs: 5000,
      verify: () => classifyIdentity(record.pid, layout.coreExe),
    });
    if (!terminated) {
      throw new Error(
        `Stale Core process is still running after termination attempt (PID=${record.pid})`,
      );
    }
    clearPidRecord(layout.pidFile);
  }
}

const HOSTED_STATUS_FAILURES = 3;

/**
 * A hosted Core is not Sash's child, so liveness comes from its host; the
 * controller, logs and health check are the same as for a spawned Core.
 */
class HostedCoreSession implements RunningCore {
  readonly startedAt = new Date().toISOString();
  private ended = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private exitListener: ((exit: CoreExit) => void) | undefined;

  constructor(
    private readonly host: HostedCore,
    readonly pid: number,
  ) {}

  isAlive(): boolean {
    return !this.ended;
  }

  onExit(listener: (exit: CoreExit) => void): void {
    this.exitListener = listener;
  }

  async checkStarting(): Promise<void> {
    if (await this.hostStillRunsIt()) return;
    this.ended = true;
    throw new Error("Core exited during startup");
  }

  startupSucceeded(): void {
    this.watch();
  }

  async abortStart(failure: unknown, errorLogTail: () => string): Promise<StartAbort> {
    if (this.ended) return exitedDuringStartup(errorLogTail);
    const message = `${errorMessage(failure)}${recentErrors(errorLogTail())}`;
    try {
      await this.host.stop();
    } catch (stopError) {
      // The session is kept so a later stop can retry; the heartbeat still
      // notices if the Core goes away on its own.
      this.watch();
      return {
        ended: false,
        error: new Error(
          `${message}\nThe TUN service could not stop the Core: ${errorMessage(stopError)}`,
        ),
      };
    }
    this.ended = true;
    return { ended: true, error: new Error(message, { cause: failure }) };
  }

  async stop(): Promise<void> {
    this.unwatch();
    try {
      await this.host.stop();
    } catch (error) {
      this.watch();
      throw error;
    }
    this.ended = true;
  }

  release(): void {
    this.ended = true;
    this.unwatch();
  }

  private async hostStillRunsIt(): Promise<boolean> {
    const state = await this.host.status();
    return state.running && state.pid === this.pid;
  }

  private watch(failures = 0): void {
    clearTimeout(this.heartbeat);
    const beat = setTimeout(async () => {
      let alive: boolean | undefined;
      try {
        alive = await this.hostStillRunsIt();
      } catch {
        // The host can be briefly busy; a vanished host takes its Core with it.
        alive = failures + 1 < HOSTED_STATUS_FAILURES ? undefined : false;
      }
      if (this.heartbeat !== beat) return;
      if (alive === false) {
        this.release();
        this.exitListener?.({ code: null, signal: null, requested: false });
      } else {
        this.watch(alive === undefined ? failures + 1 : 0);
      }
    }, 1000);
    beat.unref();
    this.heartbeat = beat;
  }

  private unwatch(): void {
    clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
  }
}

export class HostedCoreRunner implements CoreRunner {
  constructor(
    private readonly host: HostedCore,
    private readonly tunExpected?: () => boolean,
  ) {}

  async launch(settings: SashSettings): Promise<RunningCore> {
    const { pid } = await this.host.start({
      ...(settings.tun.device !== undefined ? { device: settings.tun.device } : {}),
    });
    return new HostedCoreSession(this.host, pid);
  }

  /**
   * A hosted Core outlives a Sash crash. The host serves only this data
   * folder, so a Core it still runs belongs to a previous Sash instance.
   */
  async reclaimStale(): Promise<void> {
    let running: boolean;
    try {
      running = (await this.host.status()).running;
    } catch {
      return; // no reachable host, no hosted Core
    }
    if (running) {
      await this.host.stop();
      return;
    }
    // Nothing runs, yet the host may still hold the Windows kill switch of a
    // crashed Core. When the configuration expects a TUN Core the guard must
    // survive — the next launch refreshes it; otherwise it is a leftover and
    // the stop converges it away (idempotent for the Core side).
    if (this.tunExpected?.()) return;
    try {
      await this.host.stop();
    } catch (error) {
      console.warn(`[sashd] Could not converge the TUN host state: ${errorMessage(error)}`);
    }
  }
}

export interface CoreRunnerOptions extends SpawnedCoreRunnerOptions {
  /**
   * Runs TUN Cores when the platform starts them outside Sash's process tree
   * (the Windows TUN service). Without it a TUN Core is spawned like any
   * other Core; its privilege comes from the Core file itself.
   */
  tunHost?: HostedCore;
  /** Whether the current configuration expects a TUN Core; steers stale host convergence. */
  tunExpected?: () => boolean;
}

export function createCoreRunner(options: CoreRunnerOptions): CoreRunner {
  const spawned = new SpawnedCoreRunner(options);
  if (!options.tunHost) return spawned;
  const hosted = new HostedCoreRunner(options.tunHost, options.tunExpected);
  return {
    launch: (settings) => (settings.tun.enable ? hosted : spawned).launch(settings),
    async reclaimStale() {
      await hosted.reclaimStale();
      await spawned.reclaimStale();
    },
  };
}
