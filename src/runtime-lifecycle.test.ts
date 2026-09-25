import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { RequestDeadlineError } from "./http.js";
import { sashLayout } from "./paths.js";
import { RuntimeLifecycle, runtimeDelta } from "./runtime-lifecycle.js";
import type { SystemProxyController } from "./sysproxy/manager.js";
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

describe("configuration reload", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-reload-test-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function coreStandIn(
    respond: (method: string, url: string) => { status: number; body?: string },
  ) {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        const method = req.method ?? "";
        const url = req.url ?? "";
        seen.push({ method, url, body });
        const outcome = respond(method, url);
        res.writeHead(outcome.status, { "Content-Type": "application/json" });
        res.end(outcome.body ?? "");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stand-in did not bind");
    return {
      seen,
      port: address.port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  function fixture(controller: string, reloadConfig?: (path: string) => Promise<void>) {
    const layout = sashLayout(root);
    const settings = testSettings({ controller });
    const core = new FakeCoreSupervisor(layout, settings);
    core.running = true;
    const events: string[] = [];
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
      ...(reloadConfig ? { reloadConfig } : {}),
    });
    const applied = {
      generated: { yaml: "rules: ['MATCH,DIRECT']\n", proxyCount: 0, source: "default" as const },
      settings: { ...settings },
      profile: null,
    };
    return { layout, settings, core, proxy, events, lifecycle, applied };
  }

  it("reloads the running Core instead of restarting it", async () => {
    const standIn = await coreStandIn(() => ({ status: 204 }));
    try {
      const f = fixture(`127.0.0.1:${standIn.port}`);
      await f.lifecycle.apply(f.applied);
      const next = {
        ...f.applied,
        generated: { ...f.applied.generated, yaml: "rules: ['MATCH,REJECT']\n" },
      };
      const starts = f.core.starts;
      const stops = f.core.stops;
      const revision = f.lifecycle.revision;
      const result = await f.lifecycle.reload(next);
      assert.equal(result.alreadyRunning, true);
      assert.equal(result.pid, f.core.pid);
      assert.equal(f.core.starts, starts);
      assert.equal(f.core.stops, stops);
      assert.equal(f.lifecycle.revision, revision + 1);
      assert.equal(fs.readFileSync(f.layout.configFile, "utf8"), next.generated.yaml);
      assert.deepEqual(
        standIn.seen.map((entry) => [entry.method, entry.url, JSON.parse(entry.body)]),
        [["PUT", "/configs", { path: f.layout.configFile }]],
      );
    } finally {
      await standIn.close();
    }
  });

  it("restores the previous configuration when the Core refuses a reload", async () => {
    const standIn = await coreStandIn(() => ({ status: 400, body: '{"message":"bad rule"}' }));
    try {
      const f = fixture(`127.0.0.1:${standIn.port}`);
      await f.lifecycle.apply(f.applied);
      const next = {
        ...f.applied,
        generated: { ...f.applied.generated, yaml: "rules: [\n" },
      };
      const revision = f.lifecycle.revision;
      await assert.rejects(f.lifecycle.reload(next), /HTTP 400/);
      assert.equal(fs.readFileSync(f.layout.configFile, "utf8"), f.applied.generated.yaml);
      assert.equal(f.lifecycle.configuration(), f.applied);
      assert.equal(f.lifecycle.revision, revision);
    } finally {
      await standIn.close();
    }
  });

  it("refuses a reload when no configuration was ever applied", async () => {
    const standIn = await coreStandIn(() => ({ status: 204 }));
    try {
      const f = fixture(`127.0.0.1:${standIn.port}`);
      await assert.rejects(f.lifecycle.reload(f.applied), /apply it with a restart/);
      assert.deepEqual(standIn.seen, []);
    } finally {
      await standIn.close();
    }
  });

  it("keeps the new configuration when a reload runs out of budget", async () => {
    // The Core answers a reload only after it finished applying, so a spent
    // budget leaves the outcome unknown: restoring the previous file here would
    // drop a change that may already be live.
    const standIn = await coreStandIn(() => ({ status: 204 }));
    try {
      const f = fixture(`127.0.0.1:${standIn.port}`, () =>
        Promise.reject(new RequestDeadlineError(180_000)),
      );
      await f.lifecycle.apply(f.applied);
      const next = {
        ...f.applied,
        generated: { ...f.applied.generated, yaml: "rules: ['MATCH,REJECT']\n" },
      };
      const revision = f.lifecycle.revision;
      await assert.rejects(f.lifecycle.reload(next), /may already be running the new/);
      assert.equal(fs.readFileSync(f.layout.configFile, "utf8"), next.generated.yaml);
      assert.equal(f.lifecycle.configuration(), f.applied);
      assert.equal(f.lifecycle.revision, revision);
    } finally {
      await standIn.close();
    }
  });
});

describe("runtime delta", () => {
  const settings = testSettings();
  const applied = (
    patch: Partial<ReturnType<typeof testSettings>> = {},
    profile: { id: string; revision: number; name: string; url: string } | null = null,
  ) => ({
    generated: { yaml: "rules: ['MATCH,DIRECT']\n", proxyCount: 0, source: "default" as const },
    settings: { ...settings, ...patch },
    profile,
  });
  it("reports nothing pending while the runtime matches the saved state", () => {
    assert.deepEqual(runtimeDelta(applied(), { profile: null, settings }), {
      pending: false,
      restartRequired: false,
    });
  });
  it("treats an unknown runtime as pending without demanding a restart", () => {
    assert.deepEqual(runtimeDelta(undefined, { profile: null, settings }), {
      pending: true,
      restartRequired: false,
    });
  });
  it("separates a new profile revision from a listener-level change", () => {
    const target = { profile: { id: "7", revision: 3 }, settings };
    assert.deepEqual(
      runtimeDelta(applied({}, { id: "7", revision: 2, name: "p", url: "" }), target),
      {
        pending: true,
        restartRequired: false,
      },
    );
    assert.deepEqual(runtimeDelta(applied({ mixedPort: 19099 }), target), {
      pending: true,
      restartRequired: true,
    });
    assert.deepEqual(runtimeDelta(applied({ allowLan: true }), target), {
      pending: true,
      restartRequired: true,
    });
  });
  it("notices a selection that was never applied", () => {
    assert.deepEqual(runtimeDelta(applied(), { profile: { id: "7", revision: 1 }, settings }), {
      pending: true,
      restartRequired: false,
    });
  });
});
