import fs from "node:fs";
import path from "node:path";
import { SashStateStore } from "./app-state.js";
import type { DaemonStatus, ProfileMeta } from "./contracts.js";
import { currentCoreVersion } from "./core-install-record.js";
import type { SashLayout } from "./paths.js";
import { DEFAULT_SETTINGS, publicSettings, type SashSettings } from "./settings.js";
import { type CoreOwnershipSnapshot, type CoreState, CoreSupervisor } from "./supervisor.js";

export function testSettings(patch: Partial<SashSettings> = {}): SashSettings {
  return {
    ...DEFAULT_SETTINGS,
    mixedPort: 18780,
    controller: "127.0.0.1:18781",
    daemonPort: 18782,
    secret: "test-core-secret",
    daemonSecret: "test-daemon-secret",
    ...patch,
  };
}

export function createTestState(layout: SashLayout, settings = testSettings()): SashStateStore {
  fs.mkdirSync(path.dirname(layout.configFile), { recursive: true });
  return new SashStateStore(layout, settings);
}

export function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function deferredValue<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function testProfile(id = "1"): ProfileMeta {
  return {
    id,
    revision: 1,
    name: `profile-${id}`,
    url: "https://example.test/profile",
    intervalHours: 24,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
}

export function testStatus(): DaemonStatus {
  const settings = testSettings();
  return {
    daemon: {
      pid: 1234,
      bootId: "test-boot",
      startedAt: "2026-09-08T00:00:00.000Z",
      port: settings.daemonPort,
    },
    revisions: { state: 0, runtime: 1 },
    mutationQueue: { active: null, queued: 0 },
    core: {
      running: true,
      healthy: true,
      pid: 4321,
      version: "v1.0.0",
      startedAt: "2026-09-08T00:00:00.000Z",
    },
    configuration: {
      pending: false,
      appliedProfile: null,
      appliedSettings: { mixedPort: settings.mixedPort, allowLan: settings.allowLan },
    },
    systemProxy: {
      desired: false,
      applied: false,
      appliedKnown: true,
      stateKnown: true,
      actual: { supported: true, enabled: false },
    },
    settings: publicSettings(settings),
    activeProfile: null,
  };
}

/** No OS processes or signals: integration tests exercise App with a deterministic Core. */
export class FakeCoreSupervisor extends CoreSupervisor {
  running = false;
  healthy = true;
  pid = 9900;
  version = "v1.0.0";
  generation = 0;
  starts = 0;
  stops = 0;
  onStart?: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
  onStatus?: () => Promise<void> | void;

  constructor(
    private readonly testLayout: SashLayout,
    settings = testSettings(),
  ) {
    super({ layout: testLayout, settings: () => settings });
  }
  override isRunning(): boolean {
    return this.running;
  }
  override ownedCoreSnapshot(): CoreOwnershipSnapshot | undefined {
    return this.running ? { pid: this.pid, generation: this.generation } : undefined;
  }
  override ownsCore(owner: CoreOwnershipSnapshot): boolean {
    return this.running && owner.pid === this.pid && owner.generation === this.generation;
  }
  override async status(): Promise<CoreState> {
    await this.onStatus?.();
    return this.running
      ? {
          running: true,
          pid: this.pid,
          healthy: this.healthy,
          version: this.version,
          startedAt: "2026-09-08T00:00:00.000Z",
        }
      : { running: false };
  }
  override async start(): Promise<{ pid: number; version: string }> {
    this.starts += 1;
    await this.onStart?.();
    if (this.running) throw new Error("Core is already running");
    this.pid += 1;
    this.generation += 1;
    this.running = true;
    this.version = currentCoreVersion(this.testLayout) || this.version;
    return { pid: this.pid, version: this.version };
  }
  override async stop(): Promise<void> {
    this.stops += 1;
    await this.onStop?.();
    this.running = false;
    this.generation += 1;
  }
  override async restart(): Promise<{ pid: number; version: string }> {
    await this.stop();
    return this.start();
  }
  override async cleanStaleCore(): Promise<void> {}
}
