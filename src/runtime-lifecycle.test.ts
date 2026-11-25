import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { mihomoEngine } from "./engine/index.js";
import { RequestDeadlineError } from "./http.js";
import { sashLayout } from "./paths.js";
import { listenerSettingsChanged, RuntimeLifecycle, runtimeDelta } from "./runtime-lifecycle.js";
import type { SystemProxyController } from "./sysproxy/manager.js";
import { FakeCoreSupervisor, testSettings } from "./testing/state.js";
import { type TunPrivilege, TunService } from "./tun-service.js";
import { defaultTunSettings } from "./tun-settings.js";

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
      engine: mihomoEngine,
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

  it("restores the applied configuration after an unexpected Core exit", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    f.core.running = false;
    await f.lifecycle.handleUnexpectedCoreExit();
    const starts = f.core.starts;
    await f.lifecycle.restoreCoreSessionWithRetries(
      f.configuration,
      (action) => Promise.resolve(action()),
      () => false,
      [0],
    );
    assert.equal(f.core.running, true);
    assert.equal(f.core.starts, starts + 1);
    assert.equal(f.lifecycle.configuration(), f.configuration);
  });

  it("does not restore TUN after the saved TUN setting changed", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    f.core.running = false;
    const starts = f.core.starts;
    const expected = {
      ...f.configuration,
      settings: {
        ...f.configuration.settings,
        tun: { ...f.configuration.settings.tun, enable: true },
      },
    };
    await f.lifecycle.restoreCoreSessionWithRetries(
      expected,
      (action) => Promise.resolve(action()),
      () => false,
      [0, 0],
    );
    assert.equal(f.core.running, false);
    assert.equal(f.core.starts, starts);
  });

  it("retries Core recovery until the process accepts the launch", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    f.core.running = false;
    let failures = 2;
    f.core.onStart = () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("controller not ready");
      }
    };
    await f.lifecycle.restoreCoreSessionWithRetries(
      f.configuration,
      (action) => Promise.resolve(action()),
      () => false,
      [0, 0, 0],
    );
    assert.equal(f.core.running, true);
    assert.equal(failures, 0);
  });

  it("gives up Core recovery after the retry budget", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    f.core.running = false;
    const starts = f.core.starts;
    f.core.onStart = () => {
      throw new Error("core cannot start");
    };
    await f.lifecycle.restoreCoreSessionWithRetries(
      f.configuration,
      (action) => Promise.resolve(action()),
      () => false,
      [0, 0, 0],
    );
    assert.equal(f.core.starts, starts + 3);
    assert.equal(f.core.running, false);
  });

  it("pauses automatic Core recovery after repeated crash cycles", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    f.core.running = false;
    const starts = f.core.starts;
    f.core.onStart = () => {
      throw new Error("core cannot start");
    };
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await f.lifecycle.restoreCoreSessionWithRetries(
        f.configuration,
        (action) => Promise.resolve(action()),
        () => false,
        [0],
      );
    }
    assert.equal(f.core.starts, starts + 3);
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
      engine: mihomoEngine,
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

  function fixture(
    controller: string,
    reloadConfig?: (path: string) => Promise<void>,
    tun?: TunService,
  ) {
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
      engine: mihomoEngine,
      controllerProbe: async () => false,
      ...(reloadConfig ? { reloadConfig } : {}),
      ...(tun ? { tun } : {}),
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

  it("reports a failed restore write alongside the Core's refusal", async () => {
    const standIn = await coreStandIn(() => ({ status: 204 }));
    try {
      const configFile = sashLayout(root).configFile;
      const f = fixture(`127.0.0.1:${standIn.port}`, async () => {
        fs.rmSync(configFile);
        fs.mkdirSync(configFile);
        throw new Error("HTTP 400: bad rule");
      });
      await f.lifecycle.apply(f.applied);
      const next = {
        ...f.applied,
        generated: { ...f.applied.generated, yaml: "rules: [\n" },
      };
      await assert.rejects(f.lifecycle.reload(next), (error: Error) => {
        assert.match(error.message, /Core refused the configuration reload/);
        assert.match(error.message, /could not be restored to disk/);
        assert.ok(error.cause instanceof Error);
        return true;
      });
      assert.equal(fs.statSync(configFile).isDirectory(), true);
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

  it("reloads in place when only disabled TUN fields differ", async () => {
    const standIn = await coreStandIn(() => ({ status: 204 }));
    try {
      const f = fixture(`127.0.0.1:${standIn.port}`);
      await f.lifecycle.apply(f.applied);
      const next = {
        ...f.applied,
        settings: {
          ...f.applied.settings,
          tun: {
            ...f.applied.settings.tun,
            stack: "gvisor" as const,
            strictRoute: true,
            dnsHijack: ["any:53"],
          },
        },
      };
      const starts = f.core.starts;
      const result = await f.lifecycle.reload(next);
      assert.equal(result.alreadyRunning, true);
      assert.equal(f.core.starts, starts);
      assert.equal(f.lifecycle.configuration(), next);
      assert.equal(standIn.seen.length, 1);
    } finally {
      await standIn.close();
    }
  });

  it("refuses a reload when the TUN enable state differs", async () => {
    const standIn = await coreStandIn(() => ({ status: 204 }));
    try {
      const f = fixture(`127.0.0.1:${standIn.port}`);
      await f.lifecycle.apply(f.applied);
      const next = {
        ...f.applied,
        settings: {
          ...f.applied.settings,
          tun: { ...f.applied.settings.tun, enable: true },
        },
      };
      await assert.rejects(f.lifecycle.reload(next), /supervised restart/);
      assert.deepEqual(standIn.seen, []);
      assert.equal(f.lifecycle.configuration(), f.applied);
    } finally {
      await standIn.close();
    }
  });

  it("refuses a reload when enabled TUN fields differ", async () => {
    const standIn = await coreStandIn(() => ({ status: 204 }));
    try {
      const layout = sashLayout(root);
      const tun = new TunService(
        {
          mechanism: "capabilities",
          inspect: async () => ({ state: "ready" }),
          install: async () => {},
          uninstall: async () => {},
        },
        layout,
      );
      const f = fixture(`127.0.0.1:${standIn.port}`, undefined, tun);
      const enabled = {
        ...f.applied,
        settings: {
          ...f.applied.settings,
          tun: { ...f.applied.settings.tun, enable: true },
        },
      };
      await f.lifecycle.apply(enabled);
      const next = {
        ...enabled,
        settings: {
          ...enabled.settings,
          tun: { ...enabled.settings.tun, stack: "gvisor" as const },
        },
      };
      await assert.rejects(f.lifecycle.reload(next), /supervised restart/);
      assert.deepEqual(standIn.seen, []);
      assert.equal(f.lifecycle.configuration(), enabled);
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

describe("TUN apply", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-tun-apply-test-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture(privilege: TunPrivilege = { state: "ready" }) {
    const layout = sashLayout(root);
    const settings = testSettings({
      systemProxy: true,
      tun: { ...defaultTunSettings(), enable: true },
    });
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
      engine: mihomoEngine,
      controllerProbe: async () => false,
      tun: new TunService(
        {
          mechanism: "capabilities",
          inspect: async () => privilege,
          install: async () => {},
          uninstall: async () => {},
        },
        layout,
      ),
    });
    const configuration = {
      generated: { yaml: "rules: ['MATCH,DIRECT']\n", proxyCount: 0, source: "default" as const },
      settings: { ...settings },
      profile: null,
    };
    return { layout, settings, core, events, lifecycle, configuration };
  }

  it("refuses TUN before stopping the running Core when the helper is not ready", async () => {
    const f = fixture({ state: "missing" });
    const ordinary = {
      ...f.configuration,
      settings: { ...f.settings, tun: { ...f.settings.tun, enable: false } },
    };
    await f.lifecycle.apply(ordinary);
    const starts = f.core.starts;
    await assert.rejects(f.lifecycle.apply(f.configuration), /Install the TUN helper first/);
    assert.equal(f.core.running, true);
    assert.equal(f.core.starts, starts);
    assert.equal(f.lifecycle.configuration(), ordinary);
  });

  it("restores the previous configuration when the TUN Core fails to start", async () => {
    const f = fixture();
    const ordinary = {
      ...f.configuration,
      generated: { ...f.configuration.generated, yaml: "rules: ['MATCH,REJECT']\n" },
      settings: { ...f.settings, tun: { ...f.settings.tun, enable: false } },
    };
    await f.lifecycle.apply(ordinary);
    f.core.onStart = () => {
      if (f.lifecycle.settings().tun.enable) throw new Error("TUN Core exited during startup");
    };
    await assert.rejects(f.lifecycle.apply(f.configuration), /TUN Core exited/);
    assert.equal(f.core.running, true);
    assert.equal(f.lifecycle.configuration(), ordinary);
    assert.equal(fs.readFileSync(f.layout.configFile, "utf8"), ordinary.generated.yaml);
  });

  it("does not restore the previous configuration when a non-TUN start fails", async () => {
    const f = fixture();
    const ordinary = {
      ...f.configuration,
      settings: { ...f.settings, tun: { ...f.settings.tun, enable: false } },
    };
    await f.lifecycle.apply(ordinary);
    const replacement = {
      ...ordinary,
      generated: { ...ordinary.generated, yaml: "rules: ['MATCH,REJECT']\n" },
    };
    const starts = f.core.starts;
    f.core.onStart = () => {
      throw new Error("Core exited during startup");
    };
    await assert.rejects(f.lifecycle.apply(replacement), /Core exited during startup/);
    assert.equal(f.core.running, false);
    assert.equal(f.core.starts, starts + 1);
    assert.equal(f.lifecycle.configuration(), undefined);
    assert.equal(fs.readFileSync(f.layout.configFile, "utf8"), replacement.generated.yaml);
  });

  it("treats a lost TUN Core like any unexpected exit", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    const starts = f.core.starts;
    f.core.running = false;
    await f.lifecycle.handleUnexpectedCoreExit();
    assert.equal(f.core.starts, starts);
    assert.equal(f.events.at(-1), "release");
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
  it("ignores advanced TUN edits while TUN is disabled but demands a restart once enabled", () => {
    const edited = {
      ...settings.tun,
      stack: "gvisor" as const,
      strictRoute: true,
      dnsHijack: ["any:53"],
    };
    assert.deepEqual(
      runtimeDelta(applied(), { profile: null, settings: { ...settings, tun: edited } }),
      {
        pending: false,
        restartRequired: false,
      },
    );
    const enabled = { ...edited, enable: true };
    assert.deepEqual(
      runtimeDelta(applied({ tun: { ...settings.tun, enable: true } }), {
        profile: null,
        settings: { ...settings, tun: enabled },
      }),
      {
        pending: true,
        restartRequired: true,
      },
    );
  });
});

describe("listener settings", () => {
  const settings = testSettings();
  it("ignores advanced TUN field edits while TUN is disabled on both sides", () => {
    const edited = {
      ...settings.tun,
      stack: "gvisor" as const,
      strictRoute: true,
      dnsHijack: ["any:53"],
    };
    assert.equal(listenerSettingsChanged(settings, { ...settings, tun: edited }), false);
  });
  it("notices advanced TUN field edits while TUN is enabled on both sides", () => {
    const appliedTun = { ...settings.tun, enable: true };
    const edited = {
      ...appliedTun,
      stack: "gvisor" as const,
      strictRoute: true,
      dnsHijack: ["any:53"],
    };
    assert.equal(
      listenerSettingsChanged({ ...settings, tun: appliedTun }, { ...settings, tun: edited }),
      true,
    );
  });
  it("notices a TUN enable flip", () => {
    assert.equal(
      listenerSettingsChanged(settings, { ...settings, tun: { ...settings.tun, enable: true } }),
      true,
    );
    assert.equal(
      listenerSettingsChanged({ ...settings, tun: { ...settings.tun, enable: true } }, settings),
      true,
    );
  });
});
