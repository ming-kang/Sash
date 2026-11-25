import fs from "node:fs";
import { assertCoreBinaryFile } from "./core.js";
import type { CoreRunner, RunningCore } from "./core-runner.js";
import type { CoreEngine } from "./engine/index.js";
import { errnoCode, errorMessage } from "./error-utils.js";
import { durableRenameSync } from "./fs-atomic.js";
import { boundedLogTailSince, logTailCursor } from "./log-follow.js";
import type { SashLayout } from "./paths.js";
import type { SashSettings } from "./settings.js";

export interface CoreState {
  running: boolean;
  pid?: number;
  startedAt?: string;
  healthy?: boolean;
  version?: string;
}

export interface CoreOwnershipSnapshot {
  readonly session: object;
  readonly pid: number;
}

export interface CoreSupervisorOptions {
  layout: SashLayout;
  settings: () => SashSettings;
  engine: CoreEngine;
  runner: CoreRunner;
  waitHealthyMs?: number;
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

export class CoreSupervisor {
  private core: RunningCore | undefined;
  private readonly layout: SashLayout;
  private readonly engine: CoreEngine;
  private readonly getSettings: () => SashSettings;
  private readonly runner: CoreRunner;
  private readonly waitHealthyMs: number;
  private readonly onExitCallback?: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => Promise<void> | void;

  constructor(opts: CoreSupervisorOptions) {
    this.layout = opts.layout;
    this.engine = opts.engine;
    this.getSettings = opts.settings;
    this.runner = opts.runner;
    this.waitHealthyMs = opts.waitHealthyMs ?? 10_000;
    this.onExitCallback = opts.onExit;
  }

  private forget(core: RunningCore): void {
    if (this.core !== core) return;
    this.core = undefined;
    core.release();
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

    const settings = this.getSettings();
    assertCoreBinaryFile(this.layout.coreExe);
    fs.mkdirSync(this.layout.logsDir, { recursive: true });
    fs.mkdirSync(this.layout.stateDir, { recursive: true });
    rotateCoreLogs(this.layout);
    const errLogCursor = logTailCursor(this.layout.coreErrLogFile);
    const errorLogTail = (): string =>
      boundedLogTailSince(this.layout.coreErrLogFile, errLogCursor, { maxLines: 20 });

    const core = await this.runner.launch(settings);
    this.core = core;
    core.onExit((exit) => {
      if (this.core !== core) return;
      this.forget(core);
      if (!exit.requested) {
        Promise.resolve(this.onExitCallback?.(exit.code, exit.signal)).catch(() => {});
      }
    });

    try {
      const version = await this.waitControllerHealthy(this.controllerApi(settings), () =>
        core.checkStarting(),
      );
      core.startupSucceeded();
      return { pid: core.pid, version };
    } catch (failure) {
      const { error, ended } = await core.abortStart(failure, errorLogTail);
      if (ended) this.forget(core);
      throw error;
    }
  }

  /**
   * Poll the controller until it reports a version or the startup deadline
   * passes; checkAlive throws the path-specific error when the Core is gone.
   */
  private async waitControllerHealthy(
    api: { version(options?: { deadlineMs?: number; attempts?: number }): Promise<string> },
    checkAlive: () => Promise<void>,
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
      `Core started but external-controller did not become healthy within ${this.waitHealthyMs}ms.`,
    );
  }

  async stop(): Promise<void> {
    const core = this.core;
    if (!core) return;
    await core.stop();
    this.forget(core);
  }

  ownedCoreSnapshot(): CoreOwnershipSnapshot | undefined {
    const core = this.core;
    return core?.isAlive() ? { session: core, pid: core.pid } : undefined;
  }

  controllerApi(settings: SashSettings) {
    return this.engine.api(settings.controller, settings.secret);
  }

  ownsCore(snapshot: CoreOwnershipSnapshot): boolean {
    return this.core === snapshot.session && this.core.isAlive();
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
      startedAt: this.core?.startedAt,
      healthy,
      version,
    };
  }

  isRunning(): boolean {
    return this.ownedCoreSnapshot() !== undefined;
  }

  async cleanStaleCore(): Promise<void> {
    if (this.core) return;
    await this.runner.reclaimStale();
  }
}
