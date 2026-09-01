import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RuntimeLifecycle } from "./runtime-lifecycle.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import type { CoreState, CoreSupervisor } from "./supervisor.js";
import type { SystemProxyState } from "./sysproxy.js";
import type { SystemProxyController } from "./system-proxy-manager.js";

interface FakeRuntime {
  lifecycle: RuntimeLifecycle;
  events: string[];
  setProxyFailure(error: Error | undefined): void;
  exitDuringProxyApply(): void;
  running(): boolean;
  proxyApplied(): boolean;
}

function createRuntime(systemProxy = false): FakeRuntime {
  const settings = { ...DEFAULT_SETTINGS, systemProxy };
  const events: string[] = [];
  let running = false;
  let pid = 1000;
  let generation = 0;
  let proxyFailure: Error | undefined;
  let exitDuringApply = false;
  let proxyApplied = false;

  const supervisor = {
    isRunning: () => running,
    ownedCoreSnapshot: () => (running ? { pid, generation } : undefined),
    ownsCore: (snapshot: { pid: number; generation: number }) =>
      running && snapshot.pid === pid && snapshot.generation === generation,
    status: async (): Promise<CoreState> => ({
      running,
      healthy: running,
      ...(running ? { pid } : {}),
    }),
    start: async () => {
      events.push("core:start");
      running = true;
      pid++;
      generation++;
      return { pid };
    },
    stop: async () => {
      events.push("core:stop");
      running = false;
      generation++;
    },
    restart: async () => {
      events.push("core:restart");
      running = true;
      pid++;
      generation++;
      return { pid };
    },
  } as unknown as CoreSupervisor;

  const proxy: SystemProxyController = {
    apply: async ({ port }) => {
      events.push(`proxy:apply:${port}`);
      if (proxyFailure) throw proxyFailure;
      proxyApplied = true;
      if (exitDuringApply) {
        running = false;
        generation++;
      }
    },
    release: async () => {
      events.push("proxy:release");
      if (proxyFailure) throw proxyFailure;
      proxyApplied = false;
    },
    recover: async () => {
      events.push("proxy:recover");
      if (proxyFailure) throw proxyFailure;
    },
    inspect: () => ({
      applied: false,
      state: { supported: true, enabled: false },
    }),
    isApplied: () => false,
    getState: (): SystemProxyState => ({ supported: true, enabled: false }),
  };

  return {
    lifecycle: new RuntimeLifecycle({ supervisor, systemProxy: proxy, settings: () => settings }),
    events,
    setProxyFailure(error) {
      proxyFailure = error;
    },
    exitDuringProxyApply() {
      exitDuringApply = true;
    },
    running: () => running,
    proxyApplied: () => proxyApplied,
  };
}

describe("RuntimeLifecycle", () => {
  it("recovers stale proxy ownership, prepares config, starts Core, then applies desired proxy", async () => {
    const runtime = createRuntime(true);

    const result = await runtime.lifecycle.start(async () => {
      runtime.events.push("config:prepare");
    });

    assert.ok(result.pid > 0);
    assert.deepEqual(runtime.events, [
      "proxy:recover",
      "config:prepare",
      "core:start",
      `proxy:apply:${DEFAULT_SETTINGS.mixedPort}`,
    ]);
    assert.deepEqual(runtime.lifecycle.state(), { phase: "running", generation: 1 });
  });

  it("prepares a restart before restoring the proxy and replacing Core", async () => {
    const runtime = createRuntime(true);
    await runtime.lifecycle.start();
    runtime.events.length = 0;

    await runtime.lifecycle.restart(async () => {
      runtime.events.push("config:prepare");
    });

    assert.deepEqual(runtime.events, [
      "config:prepare",
      "proxy:release",
      "core:restart",
      `proxy:apply:${DEFAULT_SETTINGS.mixedPort}`,
    ]);
  });

  it("restores proxy ownership before stopping Core", async () => {
    const runtime = createRuntime(true);
    await runtime.lifecycle.start();
    runtime.events.length = 0;

    await runtime.lifecycle.stop();

    assert.deepEqual(runtime.events, ["proxy:release", "core:stop"]);
    assert.equal(runtime.running(), false);
    assert.equal(runtime.lifecycle.state().phase, "stopped");
  });

  it("does not stop a healthy Core when proxy restoration fails", async () => {
    const runtime = createRuntime(false);
    await runtime.lifecycle.start();
    runtime.events.length = 0;
    runtime.setProxyFailure(new Error("restore failed"));

    await assert.rejects(runtime.lifecycle.stop(), /restore failed/);

    assert.deepEqual(runtime.events, ["proxy:release"]);
    assert.equal(runtime.running(), true);
    assert.equal(runtime.lifecycle.state().phase, "running");
  });

  it("serializes concurrent transitions", async () => {
    const runtime = createRuntime(false);

    const start = runtime.lifecycle.start();
    const restart = runtime.lifecycle.restart();
    const stop = runtime.lifecycle.stop();
    await Promise.all([start, restart, stop]);

    assert.deepEqual(runtime.events, [
      "proxy:recover",
      "core:start",
      "proxy:release",
      "core:restart",
      "proxy:release",
      "core:stop",
    ]);
    assert.equal(runtime.running(), false);
    assert.equal(runtime.lifecycle.state().generation, 3);
  });

  it("releases proxy ownership after an unexpected Core exit", async () => {
    const runtime = createRuntime(false);

    await runtime.lifecycle.handleUnexpectedCoreExit();

    assert.deepEqual(runtime.events, ["proxy:release"]);
    assert.equal(runtime.lifecycle.state().phase, "stopped");
  });

  it("ignores a delayed exit callback after a replacement Core is running", async () => {
    const runtime = createRuntime(true);
    await runtime.lifecycle.start();
    runtime.events.length = 0;

    const restart = runtime.lifecycle.restart();
    const delayedExit = runtime.lifecycle.handleUnexpectedCoreExit();
    await Promise.all([restart, delayedExit]);

    assert.deepEqual(runtime.events, [
      "proxy:release",
      "core:restart",
      `proxy:apply:${DEFAULT_SETTINGS.mixedPort}`,
    ]);
    assert.equal(runtime.lifecycle.state().phase, "running");
  });

  it("reconciles desired proxy state on an idempotent start", async () => {
    const runtime = createRuntime(true);
    await runtime.lifecycle.start();
    runtime.events.length = 0;

    await runtime.lifecycle.start();

    assert.deepEqual(runtime.events, [`proxy:apply:${DEFAULT_SETTINGS.mixedPort}`]);
  });

  it("releases the proxy when Core exits while it is being applied", async () => {
    const runtime = createRuntime(true);
    runtime.exitDuringProxyApply();

    await assert.rejects(runtime.lifecycle.start(), /ownership was lost while applying/);

    assert.deepEqual(runtime.events, [
      "proxy:recover",
      "core:start",
      `proxy:apply:${DEFAULT_SETTINGS.mixedPort}`,
      "proxy:release",
    ]);
    assert.equal(runtime.proxyApplied(), false);
  });
});
