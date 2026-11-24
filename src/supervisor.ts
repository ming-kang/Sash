import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Agent } from "undici";
import { assertCoreBinaryFile } from "./core.js";
import { type CoreEngine, mihomoEngine } from "./engine/index.js";
import { errnoCode, errorMessage } from "./error-utils.js";
import { durableRenameSync } from "./fs-atomic.js";
import { type CoreLauncher, directCoreLauncher, type PrivilegedCore } from "./launcher/index.js";
import { boundedLogTailSince, logTailCursor } from "./log-follow.js";
import type { SashLayout } from "./paths.js";
import type { ProcessIdentity, ProcessIdentityVerifier } from "./process.js";
import {
  classifyProcessIdentityAsync,
  clearPidRecord,
  isProcessAlive,
  killProcessGracefully,
  readPidRecord,
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

export interface CoreOwnershipSnapshot {
  readonly child: object;
  readonly pid: number;
}

export interface CoreSupervisorOptions {
  layout: SashLayout;
  settings: () => SashSettings;
  engine?: CoreEngine;
  spawnFn?: (layout: SashLayout, settings: SashSettings) => ChildProcess;
  privilegedLauncher?: CoreLauncher;
  waitHealthyMs?: number;
  isAliveFn?: typeof isProcessAlive;
  killFn?: typeof killProcessGracefully;
  classifyIdentityFn?: ProcessIdentityVerifier;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => Promise<void> | void;
}

export const CORE_LOG_ROTATE_BYTES = 10 * 1024 * 1024;

export function rotateCoreLogs(layout: SashLayout): void {
  const targets = [layout.coreLogFile, layout.coreErrLogFile];
  for (const target of targets) {
    try {
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(target);
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") throw error;
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size >= CORE_LOG_ROTATE_BYTES) {
        durableRenameSync(target, `${target}.1`);
      }
    } catch (error) {
      console.error(`[sashd] Could not rotate Core log ${target}: ${errorMessage(error)}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function managedPathsMatch(leftPath: string, rightPath: string): boolean {
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export class CoreSupervisor {
  private child: ChildProcess | null = null;
  private readonly pidRecordOwners = new WeakSet<ChildProcess>();
  private childStartedAt: string | undefined;
  private stopping = false;
  private readonly layout: SashLayout;
  private readonly engine: CoreEngine;
  private readonly getSettings: () => SashSettings;
  private readonly direct: CoreLauncher;
  private readonly privilegedLauncher: CoreLauncher | undefined;
  private privileged: PrivilegedCore | undefined;
  private controllerAgent: Agent | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly waitHealthyMs: number;
  private readonly isAlive: typeof isProcessAlive;
  private readonly kill: typeof killProcessGracefully;
  private readonly classifyIdentity: ProcessIdentityVerifier;
  private readonly onExitCallback?: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => Promise<void> | void;

  constructor(opts: CoreSupervisorOptions) {
    this.layout = opts.layout;
    this.engine = opts.engine ?? mihomoEngine;
    this.getSettings = opts.settings;
    this.waitHealthyMs = opts.waitHealthyMs ?? 10_000;
    this.isAlive = opts.isAliveFn ?? isProcessAlive;
    this.kill = opts.killFn ?? killProcessGracefully;
    this.classifyIdentity = opts.classifyIdentityFn ?? classifyProcessIdentityAsync;
    this.onExitCallback = opts.onExit;
    const spawnFn = opts.spawnFn;
    this.direct = spawnFn
      ? { launch: (layout, settings) => ({ mode: "direct", child: spawnFn(layout, settings) }) }
      : directCoreLauncher(this.engine);
    this.privilegedLauncher = opts.privilegedLauncher;
  }

  private async ownedChildIdentity(child: ChildProcess): Promise<ProcessIdentity> {
    if (this.child !== child) return "mismatch";
    if (child.exitCode !== null && child.exitCode !== undefined) return "mismatch";
    if (child.signalCode !== null && child.signalCode !== undefined) return "mismatch";
    if (!child.pid || !this.isAlive(child.pid)) return "mismatch";
    const identity = await this.classifyIdentity(child.pid, this.layout.coreExe);
    return this.child === child && this.isAlive(child.pid) ? identity : "mismatch";
  }

  private clearOwnedPidRecord(child: ChildProcess): void {
    if (this.pidRecordOwners.delete(child)) clearPidRecord(this.layout.pidFile);
  }

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
    const active = this.ownedCoreSnapshot();
    if (active) {
      throw new Error(`Core is already running (PID=${active.pid})`);
    }

    if (!fs.existsSync(this.layout.coreExe)) {
      throw new Error(`Core executable not found at ${this.layout.coreExe}`);
    }
    if (!fs.existsSync(this.layout.configFile)) {
      throw new Error(`Core config not found at ${this.layout.configFile}`);
    }

    this.stopping = false;
    const settings = this.getSettings();
    if (settings.tun.enable) return this.startPrivileged(settings);
    assertCoreBinaryFile(this.layout.coreExe);
    fs.mkdirSync(this.layout.logsDir, { recursive: true });
    fs.mkdirSync(this.layout.stateDir, { recursive: true });
    rotateCoreLogs(this.layout);
    const errLogCursor = logTailCursor(this.layout.coreErrLogFile);
    const launch = this.direct.launch(this.layout, settings);
    const launched = launch instanceof Promise ? await launch : launch;
    if (launched.mode !== "direct") throw new Error("Invalid launcher for non-TUN Core");
    const child = launched.child;
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
      if (this.child !== child) return;
      const wasStopping = this.stopping;
      this.child = null;
      this.childStartedAt = undefined;
      this.clearOwnedPidRecord(child);
      if (!wasStopping) {
        Promise.resolve(this.onExitCallback?.(code, signal)).catch(() => {});
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

    const api = this.engine.api(settings.controller, settings.secret);
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
        if (this.child === child) {
          this.child = null;
          this.childStartedAt = undefined;
        }
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
      } catch {}
      await sleep(250);
    }

    const terminated = await this.abortStart(child, pid);
    const details = boundedLogTailSince(this.layout.coreErrLogFile, errLogCursor, {
      maxLines: 20,
    });
    const cleanup = terminated
      ? ""
      : " The process could not be confirmed stopped; PID state was preserved.";
    throw new Error(
      `Core started but external-controller did not become healthy within ${this.waitHealthyMs}ms.${cleanup}${
        details ? `\nRecent errors:\n${details}` : ""
      }`,
    );
  }

  private forgetPrivileged(child: PrivilegedCore): void {
    if (this.privileged !== child) return;
    clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
    this.privileged = undefined;
    void this.controllerAgent?.destroy().catch(() => {});
    this.controllerAgent = undefined;
    this.childStartedAt = undefined;
  }

  private watchPrivileged(child: PrivilegedCore): void {
    this.heartbeat = setTimeout(async () => {
      if (this.privileged !== child || this.stopping) return;
      let alive = false;
      try {
        alive = await child.alive();
      } catch {
        // The helper owns cleanup when IPC is disconnected.
      }
      if (this.privileged !== child || this.stopping) return;
      if (alive) {
        this.watchPrivileged(child);
      } else {
        this.forgetPrivileged(child);
        Promise.resolve(this.onExitCallback?.(null, null)).catch(() => {});
      }
    }, 1000);
    this.heartbeat.unref();
  }

  private async startPrivileged(
    settings: SashSettings,
  ): Promise<{ pid: number; version?: string }> {
    if (!this.privilegedLauncher) throw new Error("Privileged TUN helper is unavailable");
    const launch = await this.privilegedLauncher.launch(this.layout, settings);
    if (launch.mode !== "privileged") throw new Error("TUN requires a privileged Core launcher");
    const child = launch.child;
    this.privileged = child;
    this.controllerAgent = new Agent({
      connect: (_options, callback) => {
        let socket: ReturnType<PrivilegedCore["controller"]["connect"]>;
        try {
          socket = child.controller.connect();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)), null);
          return;
        }
        const failed = (error: Error) => callback(error, null);
        socket.once("error", failed);
        socket.once("connect", () => {
          socket.removeListener("error", failed);
          callback(null, socket);
        });
      },
    });
    this.childStartedAt = new Date().toISOString();
    const deadline = Date.now() + this.waitHealthyMs;
    const api = this.controllerApi(settings);
    try {
      while (Date.now() < deadline) {
        if (!(await child.alive())) throw new Error("Privileged Core exited during startup");
        let version: string | undefined;
        try {
          // 5s per attempt: the privileged controller transport may need to
          // spawn its IPC shim before the first request completes (Windows
          // pipe-client exe boot + pipe attach exceeds a 1s budget); the
          // connection is then reused by later requests.
          version = await api.version({ deadlineMs: 5_000, attempts: 1 });
        } catch {
          await sleep(250);
          continue;
        }
        this.watchPrivileged(child);
        return { pid: child.pid, version };
      }
      throw new Error("Privileged Core controller did not become healthy");
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.privileged) {
      const child = this.privileged;
      this.stopping = true;
      try {
        await child.stop();
        this.forgetPrivileged(child);
      } catch (error) {
        this.stopping = false;
        clearTimeout(this.heartbeat);
        this.watchPrivileged(child);
        throw error;
      }
      return;
    }
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
      throw new Error("Core process is still running after termination attempt");
    }
    if (this.child === child) {
      this.child = null;
      this.childStartedAt = undefined;
      this.clearOwnedPidRecord(child);
    }
  }

  ownedCoreSnapshot(): CoreOwnershipSnapshot | undefined {
    if (this.privileged) return { child: this.privileged, pid: this.privileged.pid };
    const child = this.child;
    if (!child?.pid || !this.isAlive(child.pid)) return undefined;
    return { child, pid: child.pid };
  }

  privilegedController(): PrivilegedCore["controller"] | undefined {
    return this.privileged?.controller;
  }

  async reloadPrivileged(configText: string): Promise<void> {
    if (!this.privileged || this.stopping) throw new Error("Privileged Core is unavailable");
    await this.privileged.reload(configText);
  }

  controllerApi(settings: SashSettings) {
    if (this.privileged && this.controllerAgent) {
      return this.engine.api("127.0.0.1:80", "", this.controllerAgent);
    }
    if (settings.tun.enable) throw new Error("Privileged Core controller unavailable");
    return this.engine.api(settings.controller, settings.secret);
  }

  ownsCore(snapshot: CoreOwnershipSnapshot): boolean {
    if (this.privileged) return this.privileged === snapshot.child;
    return Boolean(this.child && this.child === snapshot.child && this.isAlive(snapshot.pid));
  }

  async status(): Promise<CoreState> {
    const ownership = this.ownedCoreSnapshot();
    if (!ownership) return { running: false };
    const state = await this.probeStatus(ownership);
    return this.ownsCore(ownership) ? state : { running: false };
  }

  private async probeStatus(ownership: CoreOwnershipSnapshot): Promise<CoreState> {
    const settings = this.getSettings();
    let healthy = false;
    let version: string | undefined;
    try {
      // A privileged status probe may have to spawn the IPC shim (Windows
      // pipe-client exe boot + pipe attach exceeds 1s), so give it the same
      // budget as the startup health check.
      version = await this.controllerApi(settings).version({
        deadlineMs: this.privileged ? 5_000 : 1000,
        attempts: 1,
      });
      healthy = true;
      if (!this.ownsCore(ownership)) return { running: false };
    } catch {
      healthy = false;
    }

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
    return this.ownedCoreSnapshot() !== undefined;
  }

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

    const identity = await this.classifyIdentity(record.pid, this.layout.coreExe);
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
