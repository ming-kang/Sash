import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MihomoApi } from "./api.js";
import { assertCoreBinaryFile } from "./core-binary.js";
import { boundedLogTailSince, logTailCursor } from "./log-follow.js";
import type { SashLayout } from "./paths.js";
import type { ProcessIdentity } from "./process.js";
import {
  buildSanitizedEnv,
  classifyProcessIdentity,
  clearPidRecord,
  isProcessAlive,
  killProcessGracefully,
  readPidRecord,
  withPrivateAppendLogFds,
  writePidRecord,
} from "./process.js";
import type { SashSettings } from "./settings.js";

export interface CoreState {
  running: boolean;
  pid?: number;
  startedAt?: string;
  healthy?: boolean;
  version?: string;
}

/** A point-in-time claim for the child currently owned by this supervisor. */
export interface CoreOwnershipSnapshot {
  /** Opaque identity of the claimed child; only compared, never inspected. */
  readonly child: object;
  readonly pid: number;
}

export interface CoreSupervisorOptions {
  layout: SashLayout;
  settings: () => SashSettings;
  spawnFn?: (layout: SashLayout, settings: SashSettings) => ChildProcess;
  waitHealthyMs?: number;
  isAliveFn?: typeof isProcessAlive;
  killFn?: typeof killProcessGracefully;
  classifyIdentityFn?: typeof classifyProcessIdentity;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => Promise<void> | void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function managedPathsMatch(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Supervise the child mihomo process directly. The child is NOT detached:
 * sashd holds its handle, monitors exit events, and cleans up state on exit.
 */
export class CoreSupervisor {
  private child: ChildProcess | null = null;
  private readonly pidRecordOwners = new WeakSet<ChildProcess>();
  private childStartedAt: string | undefined;
  private stopping = false;
  private readonly layout: SashLayout;
  private readonly getSettings: () => SashSettings;
  private readonly spawnFn: (layout: SashLayout, settings: SashSettings) => ChildProcess;
  private readonly waitHealthyMs: number;
  private readonly isAlive: typeof isProcessAlive;
  private readonly kill: typeof killProcessGracefully;
  private readonly classifyIdentity: typeof classifyProcessIdentity;
  private readonly onExitCallback?: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => Promise<void> | void;

  constructor(opts: CoreSupervisorOptions) {
    this.layout = opts.layout;
    this.getSettings = opts.settings;
    this.waitHealthyMs = opts.waitHealthyMs ?? 10_000;
    this.isAlive = opts.isAliveFn ?? isProcessAlive;
    this.kill = opts.killFn ?? killProcessGracefully;
    this.classifyIdentity = opts.classifyIdentityFn ?? classifyProcessIdentity;
    this.onExitCallback = opts.onExit;
    this.spawnFn = opts.spawnFn ?? this.defaultSpawn.bind(this);
  }

  private ownedChildIdentity(child: ChildProcess): ProcessIdentity {
    if (this.child !== child) return "mismatch";
    if (child.exitCode !== null && child.exitCode !== undefined) return "mismatch";
    if (child.signalCode !== null && child.signalCode !== undefined) return "mismatch";
    return child.pid && this.isAlive(child.pid) ? "match" : "mismatch";
  }

  private defaultSpawn(layout: SashLayout, _settings: SashSettings): ChildProcess {
    assertCoreBinaryFile(layout.coreExe);
    fs.mkdirSync(layout.logsDir, { recursive: true });
    fs.mkdirSync(layout.stateDir, { recursive: true });

    return withPrivateAppendLogFds(
      layout.coreLogFile,
      layout.coreErrLogFile,
      ({ stdoutFd, stderrFd }) =>
        spawn(layout.coreExe, ["-d", layout.root, "-f", layout.configFile], {
          cwd: layout.root,
          stdio: ["ignore", stdoutFd, stderrFd],
          windowsHide: true,
          env: buildSanitizedEnv(),
        }),
    );
  }

  private clearOwnedPidRecord(child: ChildProcess): void {
    if (this.pidRecordOwners.delete(child)) clearPidRecord(this.layout.pidFile);
  }

  /** Terminate a just-spawned child after a startup failure. */
  private async abortStart(child: ChildProcess, pid: number): Promise<boolean> {
    this.stopping = true;
    const terminated = await this.kill(pid, {
      timeoutMs: 3000,
      verify: () => this.ownedChildIdentity(child),
    });
    if (terminated && this.child === child) {
      this.child = null;
      this.childStartedAt = undefined;
      this.clearOwnedPidRecord(child);
    }
    return terminated;
  }

  async start(): Promise<{ pid: number; version?: string }> {
    if (this.child && this.isAlive(this.child.pid ?? -1)) {
      throw new Error(`Core is already running (PID=${this.child.pid})`);
    }

    if (!fs.existsSync(this.layout.coreExe)) {
      throw new Error(`Core executable not found at ${this.layout.coreExe}`);
    }
    if (!fs.existsSync(this.layout.configFile)) {
      throw new Error(`Core config not found at ${this.layout.configFile}`);
    }

    this.stopping = false;
    const settings = this.getSettings();
    const errLogCursor = logTailCursor(this.layout.coreErrLogFile);
    const child = this.spawnFn(this.layout, settings);
    // Attach the error listener before any early return: an asynchronous
    // spawn failure must never surface as an unhandled "error" event.
    let spawnError: Error | undefined;
    child.on("error", (err) => {
      spawnError = err;
    });
    const pid = child.pid;
    if (!pid) {
      throw new Error("Failed to start core process (no PID returned)");
    }

    this.child = child;
    this.childStartedAt = new Date().toISOString();

    child.once("exit", (code, signal) => {
      // A stale exit from a replaced process (restart race) must not clobber
      // the new child handle, the new PID record, or trigger onExit actions.
      if (this.child !== child) return;
      const wasStopping = this.stopping;
      this.child = null;
      this.childStartedAt = undefined;
      this.clearOwnedPidRecord(child);
      if (!wasStopping) {
        Promise.resolve(this.onExitCallback?.(code, signal)).catch(() => {
          // ignore rejection in exit callback
        });
      }
    });

    try {
      writePidRecord(this.layout.pidFile, {
        pid,
        exe: this.layout.coreExe,
        startedAt: this.childStartedAt,
      });
      this.pidRecordOwners.add(child);
    } catch (err) {
      const terminated = await this.abortStart(child, pid);
      const cleanup = terminated ? "" : `; process ${pid} could not be confirmed stopped`;
      throw new Error(`Failed to persist Core PID ownership: ${(err as Error).message}${cleanup}`);
    }

    const api = new MihomoApi(settings.controller, settings.secret);
    const deadline = Date.now() + this.waitHealthyMs;
    let version: string | undefined;

    while (Date.now() < deadline) {
      if (spawnError) {
        const terminated = await this.abortStart(child, pid);
        const details = boundedLogTailSince(this.layout.coreErrLogFile, errLogCursor, {
          maxLines: 20,
        });
        const cleanup = terminated ? "" : `; process ${pid} could not be confirmed stopped`;
        throw new Error(
          `Failed to start core: ${spawnError.message}${cleanup}${details ? `\n${details}` : ""}`,
        );
      }

      if (!this.isAlive(pid)) {
        this.clearOwnedPidRecord(child);
        const details = boundedLogTailSince(this.layout.coreErrLogFile, errLogCursor, {
          maxLines: 20,
        });
        throw new Error(
          `Core exited during startup.${details ? `\nRecent errors:\n${details}` : ""}`,
        );
      }

      try {
        version = await api.version();
        if (this.isAlive(pid)) return { pid, version };
      } catch {
        // Keep waiting until the owned process exposes a ready controller.
      }
      await sleep(250);
    }

    // Health check timed out. Preserve ownership records unless termination
    // is positively confirmed, so later recovery can still identify the Core.
    const terminated = await this.abortStart(child, pid);
    const details = boundedLogTailSince(this.layout.coreErrLogFile, errLogCursor, {
      maxLines: 20,
    });
    const cleanup = terminated
      ? ""
      : " The process could not be confirmed stopped; PID state was preserved.";
    throw new Error(
      `Core started (PID=${pid}) but external-controller did not become healthy within ${this.waitHealthyMs}ms.${cleanup}${
        details ? `\nRecent errors:\n${details}` : ""
      }`,
    );
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child?.pid || !this.isAlive(child.pid)) {
      this.child = null;
      this.childStartedAt = undefined;
      clearPidRecord(this.layout.pidFile);
      return;
    }

    this.stopping = true;
    const pid = child.pid;
    const terminated = await this.kill(pid, {
      timeoutMs: 8000,
      verify: () => this.ownedChildIdentity(child),
    });
    if (!terminated) {
      throw new Error(`Core process is still running after termination attempt (PID=${pid})`);
    }
    if (this.child === child) {
      this.child = null;
      this.childStartedAt = undefined;
      this.clearOwnedPidRecord(child);
    }
  }

  async restart(): Promise<{ pid: number; version?: string }> {
    await this.stop();
    return this.start();
  }

  /** Capture the currently live child so callers can detect replacement across awaits. */
  ownedCoreSnapshot(): CoreOwnershipSnapshot | undefined {
    const child = this.child;
    if (!child?.pid || !this.isAlive(child.pid)) return undefined;
    return { child, pid: child.pid };
  }

  /** True only while the exact child captured by `ownedCoreSnapshot` remains live. */
  ownsCore(snapshot: CoreOwnershipSnapshot): boolean {
    return Boolean(this.child && this.child === snapshot.child && this.isAlive(snapshot.pid));
  }

  /** Every read probes the controller directly; DaemonEvents already throttles polling. */
  async status(): Promise<CoreState> {
    const ownership = this.ownedCoreSnapshot();
    if (!ownership) return { running: false };
    const state = await this.probeStatus(ownership);
    return this.ownsCore(ownership) ? state : { running: false };
  }

  private async probeStatus(ownership: CoreOwnershipSnapshot): Promise<CoreState> {
    const settings = this.getSettings();
    const api = new MihomoApi(settings.controller, settings.secret);
    let healthy = false;
    let version: string | undefined;
    try {
      version = await api.version({ deadlineMs: 1000, attempts: 1 });
      healthy = true;
      if (!this.ownsCore(ownership)) return { running: false };
    } catch {
      healthy = false;
    }

    // The controller probe can outlive its child or overlap a replacement.
    // Never describe a different (or dead) child with this probe result.
    if (!this.ownsCore(ownership)) return { running: false };

    return {
      running: true,
      pid: ownership.pid,
      startedAt: this.childStartedAt,
      healthy,
      version,
    };
  }

  isRunning(): boolean {
    return Boolean(this.child && this.isAlive(this.child.pid ?? -1));
  }

  /**
   * Reconcile stale core processes on daemon startup: if a previous core
   * was orphaned, verify its executable identity before killing it.
   */
  async cleanStaleCore(): Promise<void> {
    const record = readPidRecord(this.layout.pidFile);
    if (!record) {
      if (fs.existsSync(this.layout.pidFile)) {
        throw new Error(`Core PID record is corrupt: ${this.layout.pidFile}`);
      }
      return;
    }

    if (!managedPathsMatch(record.exe, this.layout.coreExe)) {
      throw new Error(`Core PID record executable does not match the managed path: ${record.exe}`);
    }
    if (!this.isAlive(record.pid)) {
      clearPidRecord(this.layout.pidFile);
      return;
    }

    const identity = this.classifyIdentity(record.pid, this.layout.coreExe);
    if (identity === "mismatch") {
      clearPidRecord(this.layout.pidFile);
      return;
    }
    if (identity === "unknown") {
      throw new Error(
        `Refusing to terminate stale Core PID ${record.pid}: process identity could not be verified`,
      );
    }

    const terminated = await this.kill(record.pid, {
      timeoutMs: 5000,
      verify: () => this.classifyIdentity(record.pid, this.layout.coreExe),
    });
    if (!terminated) {
      throw new Error(
        `Stale Core process is still running after termination attempt (PID=${record.pid})`,
      );
    }
    clearPidRecord(this.layout.pidFile);
  }
}
