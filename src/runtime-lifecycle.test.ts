import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { sashLayout } from "./paths.js";
import { RuntimeLifecycle } from "./runtime-lifecycle.js";
import type { SystemProxyController } from "./system-proxy-manager.js";
import { FakeCoreSupervisor, testSettings } from "./testing/state.js";

describe("Core and proxy lifecycle", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-runtime-test-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  function fixture(systemProxy = true) {
    const layout = sashLayout(root);
    const settings = testSettings({ systemProxy });
    const core = new FakeCoreSupervisor(layout, settings);
    const events: string[] = [];
    core.onStart = () => {
      events.push("start");
    };
    core.onStop = () => {
      events.push("stop");
    };
    const proxy: SystemProxyController = {
      apply: async ({ port }) => {
        events.push(`proxy:${port}`);
      },
      release: async () => {
        events.push("release");
      },
      inspect: async () => ({
        applied: false,
        appliedKnown: true,
        stateKnown: true,
        state: { supported: true, enabled: false },
      }),
    };
    const lifecycle = new RuntimeLifecycle({
      layout,
      supervisor: core,
      systemProxy: proxy,
      settings: () => settings,
      controllerProbe: async () => false,
    });
    const configuration = {
      generated: { yaml: "rules: ['MATCH,DIRECT']\n", proxyCount: 0, source: "default" as const },
      settings: { ...settings },
      profile: null,
    };
    return { layout, settings, core, proxy, events, lifecycle, configuration };
  }

  it("releases proxy before replacement and enables it only after Core starts", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    assert.deepEqual(f.events, ["release", "stop", "start", `proxy:${f.settings.mixedPort}`]);
    f.events.length = 0;
    await f.lifecycle.stop();
    assert.deepEqual(f.events, ["release", "stop"]);
    assert.equal(f.core.running, false);
  });
  it("distinguishes an existing Core and returns its applied port despite saved edits", async () => {
    const f = fixture();
    const first = await f.lifecycle.apply(f.configuration);
    assert.equal(first.alreadyRunning, false);
    assert.equal(first.mixedPort, 18780);
    f.settings.mixedPort = 18880;
    const repeated = await f.lifecycle.start();
    assert.equal(repeated.alreadyRunning, true);
    assert.equal(repeated.mixedPort, 18780);
    assert.equal(f.core.starts, 1);
  });
  it("keeps a healthy Core when restoring the proxy fails", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    f.events.length = 0;
    f.proxy.release = async () => {
      throw new Error("restore failed");
    };
    await assert.rejects(f.lifecycle.stop(), /restore failed/);
    assert.equal(f.core.running, true);
    assert.deepEqual(f.events, []);
  });
  it("applies proxy to the running port while saved network preferences wait for Apply", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    f.settings.mixedPort = 18880;
    f.events.length = 0;
    await f.lifecycle.reconcileSystemProxy();
    assert.deepEqual(f.events, ["proxy:18780"]);
  });
  it("retains saved configuration after startup failure and leaves proxy released", async () => {
    const f = fixture();
    f.core.onStart = () => {
      throw new Error("cannot start");
    };
    await assert.rejects(f.lifecycle.apply(f.configuration), /cannot start/);
    assert.equal(f.core.running, false);
    assert.equal(f.lifecycle.configuration(), undefined);
    assert.equal(fs.readFileSync(f.layout.configFile, "utf8"), f.configuration.generated.yaml);
    assert.equal(
      f.events.some((event) => event.startsWith("proxy:")),
      false,
    );
  });
  it("ignores delayed exit cleanup once a replacement is running", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    f.events.length = 0;
    await f.lifecycle.handleUnexpectedCoreExit();
    assert.deepEqual(f.events, []);
    f.core.running = false;
    await f.lifecycle.handleUnexpectedCoreExit();
    assert.deepEqual(f.events, ["release"]);
  });
  it("does not terminate stale Core when startup proxy recovery fails", async () => {
    const f = fixture();
    let cleaned = false;
    f.core.cleanStaleCore = async () => {
      cleaned = true;
    };
    f.proxy.release = async () => {
      throw new Error("restore failed");
    };
    await assert.rejects(f.lifecycle.recoverStartup(), /restore failed/);
    assert.equal(cleaned, false);
  });
  it("refuses applying over an unowned reachable controller", async () => {
    const f = fixture();
    const lifecycle = new RuntimeLifecycle({
      layout: f.layout,
      supervisor: f.core,
      systemProxy: f.proxy,
      settings: () => f.settings,
      controllerProbe: async () => true,
    });
    await assert.rejects(lifecycle.apply(f.configuration), /unowned Core controller/);
    assert.equal(f.core.starts, 0);
    assert.equal(fs.existsSync(f.layout.configFile), false);
  });
});
