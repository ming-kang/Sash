import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { MihomoApi } from "./api.js";
import type { SashLayout } from "./paths.js";
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
import type { SystemProxyState } from "./sysproxy.js";

export interface CoreState {
  running: boolean;
  pid?: number;
  startedAt?: string;
  healthy?: boolean;
  version?: string;
}

export interface SysproxyAdapter {
  enable(opts: { host?: string; port: number }): Promise<void>;
  disable(): Promise<void>;
  getState(): SystemProxyState;
}

export interface CoreSupervisorOptions {
  layout: SashLayout;
  settings: () => SashSettings;
  spawnFn?: (layout: SashLayout, settings: SashSettings) => ChildProcess;
  waitHealthyMs?: number;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => Promise<void> | void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  private readonly onExitCallback?: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => Promise<void> | void;

  constructor(opts: CoreSupervisorOptions) {
    this.layout = opts.layout;
    this.getSettings = opts.settings;
    this.waitHealthyMs = opts.waitHealthyMs ?? 10_000;
    this.onExitCallback = opts.onExit;
    this.spawnFn = opts.spawnFn ?? this.defaultSpawn.bind(this);
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
    if (this.child && isProcessAlive(this.child.pid ?? -1)) {
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
    writePidRecord(this.layout.pidFile, {
      pid,
      exe: this.layout.coreExe,
      startedAt: this.childStartedAt,
    });

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

    const api = new MihomoApi(settings.controller, settings.secret);
    const deadline = Date.now() + this.waitHealthyMs;
    let version: string | undefined;

    while (Date.now() < deadline) {
      if (spawnError) {
        clearPidRecord(this.layout.pidFile);
        const details = tailFile(this.layout.coreErrLogFile, 20);
        throw new Error(
          `Failed to start core: ${spawnError.message}${details ? `\n${details}` : ""}`,
        );
      }

      if (!isProcessAlive(pid)) {
        clearPidRecord(this.layout.pidFile);
        const details = tailFile(this.layout.coreErrLogFile, 20);
        throw new Error(
          `Core exited during startup.${details ? `\nRecent errors:\n${details}` : ""}`,
        );
      }

      try {
        version = await api.version();
        return { pid, version };
      } catch {
        // keep polling
      }
      await sleep(250);
    }

    // Health check timed out
    this.stopping = true;
    await killProcessGracefully(pid, { timeoutMs: 3000 });
    clearPidRecord(this.layout.pidFile);
    this.child = null;
    const details = tailFile(this.layout.coreErrLogFile, 20);
    throw new Error(
      `Core started (PID=${pid}) but external-controller did not become healthy within ${this.waitHealthyMs}ms.${
        details ? `\nRecent errors:\n${details}` : ""
      }`,
    );
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child?.pid || !isProcessAlive(child.pid)) {
      this.child = null;
      clearPidRecord(this.layout.pidFile);
      return;
    }

    this.stopping = true;
    const pid = child.pid;
    await killProcessGracefully(pid, { timeoutMs: 8000 });
    this.child = null;
    this.childStartedAt = undefined;
    clearPidRecord(this.layout.pidFile);
  }

  async restart(): Promise<{ pid: number; version?: string }> {
    await this.stop();
    return this.start();
  }

  async status(): Promise<CoreState> {
    const child = this.child;
    if (!child?.pid || !isProcessAlive(child.pid)) {
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
    return Boolean(this.child && isProcessAlive(this.child.pid ?? -1));
  }

  /**
   * Reconcile stale core processes on daemon startup: if a previous core
   * was orphaned, verify its executable identity before killing it.
   */
  async cleanStaleCore(): Promise<void> {
    const record = readPidRecord(this.layout.pidFile);
    if (!record) return;

    if (!isProcessAlive(record.pid)) {
      clearPidRecord(this.layout.pidFile);
      return;
    }

    const identity = classifyProcessIdentity(record.pid, record.exe);
    if (identity === "match") {
      await killProcessGracefully(record.pid, { timeoutMs: 5000 });
    }
    clearPidRecord(this.layout.pidFile);
  }
}
