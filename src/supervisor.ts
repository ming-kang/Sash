import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MihomoApi } from "./api.js";
import type { SashLayout } from "./paths.js";
import type { ProcessIdentity } from "./process.js";
import {
  buildSanitizedEnv,
  classifyProcessIdentity,
  clearPidRecord,
  isProcessAlive,
  killProcessGracefully,
  readPidRecord,
  tailFile,
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

export interface CoreSupervisorOptions {
  layout: SashLayout;
  settings: () => SashSettings;
  spawnFn?: (layout: SashLayout, settings: SashSettings) => ChildProcess;
  waitHealthyMs?: number;
  expectedVersion?: string;
  isAliveFn?: typeof isProcessAlive;
  killFn?: typeof killProcessGracefully;
  classifyIdentityFn?: typeof classifyProcessIdentity;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => Promise<void> | void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function versionMatches(observed: string, expected: string): boolean {
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9._-])${escaped}($|[^A-Za-z0-9._-])`).test(observed);
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
  private childStartedAt: string | undefined;
  private stopping = false;
  private readonly layout: SashLayout;
  private readonly getSettings: () => SashSettings;
  private readonly spawnFn: (layout: SashLayout, settings: SashSettings) => ChildProcess;
  private readonly waitHealthyMs: number;
  private readonly expectedVersion?: string;
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
    this.expectedVersion = opts.expectedVersion;
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
    fs.mkdirSync(layout.logsDir, { recursive: true });
    fs.mkdirSync(layout.stateDir, { recursive: true });

    const outFd = fs.openSync(layout.coreLogFile, "a", 0o600);
    let errFd: number | undefined;

    try {
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(layout.coreLogFile, 0o600);
        } catch {
          // ignore
        }
      }
      errFd = fs.openSync(layout.coreErrLogFile, "a", 0o600);
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(layout.coreErrLogFile, 0o600);
        } catch {
          // ignore
        }
      }

      const sanitizedEnv = buildSanitizedEnv();
      const child = spawn(layout.coreExe, ["-d", layout.root, "-f", layout.configFile], {
        cwd: layout.root,
        stdio: ["ignore", outFd, errFd],
        windowsHide: true,
        env: sanitizedEnv,
      });

      return child;
    } finally {
      try {
        fs.closeSync(outFd);
      } catch {
        // ignore
      }
      if (errFd !== undefined) {
        try {
          fs.closeSync(errFd);
        } catch {
          // ignore
        }
      }
    }
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
    const child = this.spawnFn(this.layout, settings);
    const pid = child.pid;
    if (!pid) {
      throw new Error("Failed to start core process (no PID returned)");
    }

    this.child = child;
    this.childStartedAt = new Date().toISOString();
    let spawnError: Error | undefined;
    child.on("error", (err) => {
      spawnError = err;
    });

    child.once("exit", (code, signal) => {
      // A stale exit from a replaced process (restart race) must not clobber
      // the new child handle, the new PID record, or trigger onExit actions.
      if (this.child !== child) return;
      const wasStopping = this.stopping;
      this.child = null;
      this.childStartedAt = undefined;
      clearPidRecord(this.layout.pidFile);
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
    } catch (err) {
      this.stopping = true;
      const terminated = await this.kill(pid, {
        timeoutMs: 3000,
        verify: () => this.ownedChildIdentity(child),
      });
      if (terminated && this.child === child) {
        this.child = null;
        this.childStartedAt = undefined;
      }
      const cleanup = terminated ? "" : `; process ${pid} could not be confirmed stopped`;
      throw new Error(`Failed to persist Core PID ownership: ${(err as Error).message}${cleanup}`);
    }

    const api = new MihomoApi(settings.controller, settings.secret);
    const deadline = Date.now() + this.waitHealthyMs;
    let version: string | undefined;
    let healthyProbes = 0;

    while (Date.now() < deadline) {
      if (spawnError) {
        this.stopping = true;
        const terminated = await this.kill(pid, {
          timeoutMs: 3000,
          verify: () => this.ownedChildIdentity(child),
        });
        if (terminated && this.child === child) {
          this.child = null;
          this.childStartedAt = undefined;
          clearPidRecord(this.layout.pidFile);
        }
        const details = tailFile(this.layout.coreErrLogFile, 20);
        const cleanup = terminated ? "" : `; process ${pid} could not be confirmed stopped`;
        throw new Error(
          `Failed to start core: ${spawnError.message}${cleanup}${details ? `\n${details}` : ""}`,
        );
      }

      if (!this.isAlive(pid)) {
        clearPidRecord(this.layout.pidFile);
        const details = tailFile(this.layout.coreErrLogFile, 20);
        throw new Error(
          `Core exited during startup.${details ? `\nRecent errors:\n${details}` : ""}`,
        );
      }

      try {
        version = await api.version();
        if (this.expectedVersion && !versionMatches(version, this.expectedVersion)) {
          throw new Error(
            `Controller version ${version} does not match expected ${this.expectedVersion}`,
          );
        }
        healthyProbes++;
        if (healthyProbes >= 2 && this.isAlive(pid)) return { pid, version };
      } catch {
        healthyProbes = 0;
      }
      await sleep(250);
    }

    // Health check timed out. Preserve ownership records unless termination
    // is positively confirmed, so later recovery can still identify the Core.
    this.stopping = true;
    const terminated = await this.kill(pid, {
      timeoutMs: 3000,
      verify: () => this.ownedChildIdentity(child),
    });
    if (terminated && this.child === child) {
      clearPidRecord(this.layout.pidFile);
      this.child = null;
      this.childStartedAt = undefined;
    }
    const details = tailFile(this.layout.coreErrLogFile, 20);
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
      clearPidRecord(this.layout.pidFile);
    }
  }

  async restart(): Promise<{ pid: number; version?: string }> {
    await this.stop();
    return this.start();
  }

  async status(): Promise<CoreState> {
    const child = this.child;
    if (!child?.pid || !this.isAlive(child.pid)) {
      return { running: false };
    }

    const settings = this.getSettings();
    const api = new MihomoApi(settings.controller, settings.secret);
    let healthy = false;
    let version: string | undefined;
    try {
      version = await api.version();
      healthy = true;
    } catch {
      healthy = false;
    }

    return {
      running: true,
      pid: child.pid,
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
