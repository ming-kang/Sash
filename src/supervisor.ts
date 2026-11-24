import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertCoreBinaryFile } from "./core.js";
import { type CoreEngine, mihomoEngine } from "./engine/index.js";
import { errnoCode, errorMessage } from "./error-utils.js";
import { durableRenameSync } from "./fs-atomic.js";
import { boundedLogTailSince, type LogFileCursor, logTailCursor } from "./log-follow.js";
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
  /**
   * Starts TUN Cores when the platform runs them outside Sash's process tree
   * (the Windows TUN service). Without it a TUN Core is spawned like any
   * other Core; its privilege comes from the Core file itself.
   */
  tunHost?: HostedCore;
  waitHealthyMs?: number;
  isAliveFn?: typeof isProcessAlive;
  killFn?: typeof killProcessGracefully;
  classifyIdentityFn?: ProcessIdentityVerifier;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => Promise<void> | void;
}

export const CORE_LOG_ROTATE_BYTES = 10 * 1024 * 1024;

const HOSTED_STATUS_FAILURES = 3;

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

interface HostedSession {
  mode: "hosted";
  host: HostedCore;
  pid: number;
}

type CoreSession = { mode: "direct"; child: ChildProcess } | HostedSession;

export class CoreSupervisor {
  private session: CoreSession | undefined;
  private readonly pidRecordOwners = new WeakSet<ChildProcess>();
  private childStartedAt: string | undefined;
  private stopping = false;
  private readonly layout: SashLayout;
  private readonly engine: CoreEngine;
  private readonly getSettings: () => SashSettings;
  private readonly spawnChild: (layout: SashLayout, settings: SashSettings) => ChildProcess;
  private readonly tunHost: HostedCore | undefined;
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
    this.spawnChild = opts.spawnFn ?? ((layout) => spawnCore(this.engine, layout));
    this.tunHost = opts.tunHost;
  }

  private ownsDirectChild(child: ChildProcess): boolean {
    return this.session?.mode === "direct" && this.session.child === child;
  }

  private ownsHostedSession(session: HostedSession): boolean {
    return this.session === session;
  }

  private async ownedChildIdentity(child: ChildProcess): Promise<ProcessIdentity> {
    if (!this.ownsDirectChild(child)) return "mismatch";
    if (child.exitCode !== null && child.exitCode !== undefined) return "mismatch";
    if (child.signalCode !== null && child.signalCode !== undefined) return "mismatch";
    if (!child.pid || !this.isAlive(child.pid)) return "mismatch";
    const identity = await this.classifyIdentity(child.pid, this.layout.coreExe);
    return this.ownsDirectChild(child) && this.isAlive(child.pid) ? identity : "mismatch";
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
    if (terminated && this.ownsDirectChild(child)) {
      this.session = undefined;
      this.childStartedAt = undefined;
      this.clearOwnedPidRecord(child);
    }
    return terminated;
  }

  private recentErrors(cursor: LogFileCursor): string {
    const details = boundedLogTailSince(this.layout.coreErrLogFile, cursor, { maxLines: 20 });
    return details ? `\nRecent errors:\n${details}` : "";
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
    assertCoreBinaryFile(this.layout.coreExe);
    fs.mkdirSync(this.layout.logsDir, { recursive: true });
    fs.mkdirSync(this.layout.stateDir, { recursive: true });
    rotateCoreLogs(this.layout);
    const errLogCursor = logTailCursor(this.layout.coreErrLogFile);
    if (settings.tun.enable && this.tunHost)
      return this.startHosted(this.tunHost, settings, errLogCursor);
    const child = this.spawnChild(this.layout, settings);
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

    this.session = { mode: "direct", child };
    this.childStartedAt = new Date().toISOString();

    child.once("exit", (code, signal) => {
      if (!this.ownsDirectChild(child)) return;
      const wasStopping = this.stopping;
      this.session = undefined;
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

    const api = this.controllerApi(settings);
    try {
      const version = await this.waitControllerHealthy(api, async () => {
        if (spawnError) throw spawnError;
        if (!this.isAlive(pid)) throw new Error("Core exited during startup");
      });
      return { pid, version };
    } catch (error) {
      if (error !== spawnError && !this.isAlive(pid)) {
        if (this.ownsDirectChild(child)) {
          this.session = undefined;
          this.childStartedAt = undefined;
        }
        this.clearOwnedPidRecord(child);
        throw new Error(`Core exited during startup.${this.recentErrors(errLogCursor)}`);
      }
      const terminated = await this.abortStart(child, pid);
      if (error === spawnError) {
        const details = boundedLogTailSince(this.layout.coreErrLogFile, errLogCursor, {
          maxLines: 20,
        });
        throw new Error(
          `Failed to start core: ${(error as Error).message}${terminated ? "" : `; process ${pid} could not be confirmed stopped`}${details ? `\n${details}` : ""}`,
        );
      }
      const cleanup = terminated
        ? ""
        : " The process could not be confirmed stopped; PID state was preserved.";
      throw new Error(`${(error as Error).message}${cleanup}${this.recentErrors(errLogCursor)}`);
    }
  }

  /**
   * Poll the controller until it reports a version or the startup deadline
   * passes; checkAlive throws the path-specific error when the Core is gone.
   */
  private async waitControllerHealthy(
    api: { version(options?: { deadlineMs?: number; attempts?: number }): Promise<string> },
    checkAlive: () => Promise<void>,
    deadlineSuffix: () => string = () => "",
  ): Promise<string> {
    const deadline = Date.now() + this.waitHealthyMs;
    while (Date.now() < deadline) {
      await checkAlive();
      let version: string | undefined;
      try {
        version = await api.version();
      } catch {}
      if (version !== undefined) {
        await checkAlive();
        return version;
      }
      await sleep(250);
    }
    throw new Error(
      `Core started but external-controller did not become healthy within ${this.waitHealthyMs}ms.${deadlineSuffix()}`,
    );
  }

  /**
   * A hosted Core is not Sash's child, so liveness comes from its host; the
   * controller, logs and health check are the same as for a spawned Core.
   */
  private async startHosted(
    host: HostedCore,
    settings: SashSettings,
    errLogCursor: LogFileCursor,
  ): Promise<{ pid: number; version?: string }> {
    const { pid } = await host.start();
    const session: HostedSession = { mode: "hosted", host, pid };
    this.session = session;
    this.childStartedAt = new Date().toISOString();
    const api = this.controllerApi(settings);
    let version: string;
    try {
      version = await this.waitControllerHealthy(
        api,
        async () => {
          const state = await host.status();
          if (!state.running || state.pid !== pid) {
            this.forgetHosted(session);
            throw new Error(`Core exited during startup.${this.recentErrors(errLogCursor)}`);
          }
        },
        () => this.recentErrors(errLogCursor),
      );
    } catch (error) {
      if (!this.ownsHostedSession(session)) throw error;
      const failure = error instanceof Error ? error : new Error(String(error));
      try {
        await host.stop();
        this.forgetHosted(session);
      } catch (stopError) {
        // Keep the session so a later stop can retry; the heartbeat still
        // notices if the Core goes away on its own.
        if (this.ownsHostedSession(session)) this.watchHosted(session);
        throw new Error(
          `${failure.message}\nThe TUN service could not stop the Core: ${errorMessage(stopError)}`,
        );
      }
      throw failure;
    }
    this.watchHosted(session);
    return { pid, version };
  }

  private forgetHosted(session: HostedSession): void {
    if (!this.ownsHostedSession(session)) return;
    clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
    this.session = undefined;
    this.childStartedAt = undefined;
  }

  private watchHosted(session: HostedSession, failures = 0): void {
    clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(async () => {
      if (!this.ownsHostedSession(session) || this.stopping) return;
      let alive: boolean | undefined;
      try {
        const state = await session.host.status();
        alive = state.running && state.pid === session.pid;
      } catch {
        // The host can be briefly busy; a vanished host takes its Core with it.
        if (failures + 1 < HOSTED_STATUS_FAILURES) alive = undefined;
        else alive = false;
      }
      if (!this.ownsHostedSession(session) || this.stopping) return;
      if (alive === false) {
        this.forgetHosted(session);
        Promise.resolve(this.onExitCallback?.(null, null)).catch(() => {});
      } else {
        this.watchHosted(session, alive === undefined ? failures + 1 : 0);
      }
    }, 1000);
    this.heartbeat.unref();
  }

  async stop(): Promise<void> {
    const session = this.session;
    if (session?.mode === "hosted") {
      this.stopping = true;
      try {
        await session.host.stop();
      } catch (error) {
        this.stopping = false;
        if (this.ownsHostedSession(session)) this.watchHosted(session);
        throw error;
      }
      this.forgetHosted(session);
      return;
    }
    const child = session?.child;
    if (!child?.pid || !this.isAlive(child.pid)) {
      this.session = undefined;
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
    if (this.ownsDirectChild(child)) {
      this.session = undefined;
      this.childStartedAt = undefined;
      this.clearOwnedPidRecord(child);
    }
  }

  ownedCoreSnapshot(): CoreOwnershipSnapshot | undefined {
    const session = this.session;
    if (!session) return undefined;
    if (session.mode === "hosted") return { child: session, pid: session.pid };
    const pid = session.child.pid;
    if (!pid || !this.isAlive(pid)) return undefined;
    return { child: session.child, pid };
  }

  controllerApi(settings: SashSettings) {
    return this.engine.api(settings.controller, settings.secret);
  }

  ownsCore(snapshot: CoreOwnershipSnapshot): boolean {
    const session = this.session;
    if (!session) return false;
    if (session.mode === "hosted") return session === snapshot.child;
    return session.child === snapshot.child && this.isAlive(snapshot.pid);
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
      version = await this.controllerApi(settings).version({ deadlineMs: 1000, attempts: 1 });
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
    await this.cleanStaleHostedCore();
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

  /**
   * A hosted Core outlives a Sash crash. The host serves only this data
   * folder, so a Core it still runs belongs to a previous Sash instance.
   */
  private async cleanStaleHostedCore(): Promise<void> {
    if (!this.tunHost || this.session) return;
    let running: boolean;
    try {
      running = (await this.tunHost.status()).running;
    } catch {
      return; // no reachable host, no hosted Core
    }
    if (running) await this.tunHost.stop();
  }
}
