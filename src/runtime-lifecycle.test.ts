import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import YAML from "yaml";
import { mihomoEngine } from "./engine/index.js";
import { errorPresentation, withErrorPresentation } from "./error-utils.js";
import { RequestDeadlineError } from "./http.js";
import { sashLayout } from "./paths.js";
import {
  CoreStartError,
  RuntimeLifecycle,
  restartRequiringSettingsChanged,
  runtimeDelta,
  verificationConfiguration,
} from "./runtime-lifecycle.js";
import type { SystemProxyController } from "./sysproxy/manager.js";
import { FakeCoreSupervisor, testSettings } from "./testing/state.js";
import { type TunPrivilege, TunService, unsupportedTunPlatform } from "./tun-service.js";
import { defaultTunSettings, disabledTun } from "./tun-settings.js";

describe("verification configuration", () => {
  const base = {
    generated: {
      yaml: "mixed-port: 18780\ntun:\n  enable: true\n  stack: system\nrules:\n  - MATCH,DIRECT\n",
      proxyCount: 0,
      source: "default" as const,
    },
    settings: testSettings({ tun: { ...defaultTunSettings(), enable: true } }),
    profile: null,
  };

  it("returns a TUN-disabled configuration unchanged", () => {
    const configuration = {
      ...base,
      settings: {
        ...base.settings,
        tun: disabledTun(base.settings.tun),
      },
    };
    assert.equal(verificationConfiguration(configuration), configuration);
  });

  it("disables TUN in settings and generated yaml without mutating the input", () => {
    const verification = verificationConfiguration(base);
    assert.notEqual(verification, base);
    assert.equal(verification.settings.tun.enable, false);
    assert.equal(verification.settings.tun.stack, base.settings.tun.stack);
    assert.deepEqual(YAML.parse(verification.generated.yaml).tun, { enable: false });
    assert.equal(YAML.parse(verification.generated.yaml)["mixed-port"], 18780);
    assert.equal(base.settings.tun.enable, true);
    assert.equal(YAML.parse(base.generated.yaml).tun.enable, true);
    assert.equal(YAML.parse(base.generated.yaml).tun.stack, "system");
  });
});

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
      tun: new TunService(unsupportedTunPlatform(), layout),
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
    await assert.rejects(f.lifecycle.apply(f.configuration), (error: unknown) => {
      if (!(error instanceof CoreStartError)) return false;
      assert.match(error.message, /cannot start/);
      assert.equal(error.restored, undefined);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, "cannot start");
      return true;
    });
    assert.equal(f.core.running, false);
    assert.equal(f.lifecycle.configuration(), undefined);
    assert.equal(fs.readFileSync(f.layout.configFile, "utf8"), f.configuration.generated.yaml);
    assert.equal(
      f.events.some((event) => event.startsWith("proxy:")),
      false,
    );
  });
  it("keeps the start failure presentation on the typed error", async () => {
    const f = fixture();
    const presentation = { message: "The Core could not start.", advice: "Inspect the Core log." };
    const failure = withErrorPresentation(new Error("cannot start"), presentation);
    f.core.onStart = () => {
      throw failure;
    };
    await assert.rejects(f.lifecycle.apply(f.configuration), (error: unknown) => {
      if (!(error instanceof CoreStartError)) return false;
      assert.equal(error.cause, failure);
      assert.deepEqual(errorPresentation(error), presentation);
      return true;
    });
  });
  it("restores the running configuration when stopping for a replacement fails", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    const replacement = {
      ...f.configuration,
      generated: { ...f.configuration.generated, yaml: "rules: ['MATCH,REJECT']\n" },
    };
    const starts = f.core.starts;
    let failures = 1;
    f.core.onStop = () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("stop failed");
      }
    };
    await assert.rejects(f.lifecycle.apply(replacement), (error: unknown) => {
      if (!(error instanceof CoreStartError)) return false;
      assert.match(error.message, /stop failed/);
      assert.equal(error.restored, f.configuration);
      return true;
    });
    assert.equal(f.core.running, true);
    assert.equal(f.core.starts, starts + 1);
    assert.equal(f.lifecycle.configuration(), f.configuration);
    assert.equal(fs.readFileSync(f.layout.configFile, "utf8"), f.configuration.generated.yaml);
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
      tun: new TunService(unsupportedTunPlatform(), f.layout),
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
      tun: tun ?? new TunService(unsupportedTunPlatform(), layout),
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
      settings: { ...f.settings, tun: disabledTun(f.settings.tun) },
    };
    await f.lifecycle.apply(ordinary);
    const starts = f.core.starts;
    await assert.rejects(f.lifecycle.apply(f.configuration), (error: unknown) => {
      if (!(error instanceof CoreStartError)) return false;
      assert.match(error.message, /Install the TUN helper first/);
      assert.equal(error.restored, ordinary);
      assert.ok(error.cause instanceof Error);
      return true;
    });
    assert.equal(f.core.running, true);
    assert.equal(f.core.starts, starts);
    assert.equal(f.lifecycle.configuration(), ordinary);
  });

  it("restores the previous configuration when the TUN Core fails to start", async () => {
    const f = fixture();
    const ordinary = {
      ...f.configuration,
      generated: { ...f.configuration.generated, yaml: "rules: ['MATCH,REJECT']\n" },
      settings: { ...f.settings, tun: disabledTun(f.settings.tun) },
    };
    await f.lifecycle.apply(ordinary);
    f.core.onStart = () => {
      if (f.lifecycle.settings().tun.enable) throw new Error("TUN Core exited during startup");
    };
    await assert.rejects(f.lifecycle.apply(f.configuration), (error: unknown) => {
      if (!(error instanceof CoreStartError)) return false;
      assert.match(error.message, /TUN Core exited/);
      assert.equal(error.restored, ordinary);
      assert.ok(error.cause instanceof Error);
      return true;
    });
    assert.equal(f.core.running, true);
    assert.equal(f.lifecycle.configuration(), ordinary);
    assert.equal(fs.readFileSync(f.layout.configFile, "utf8"), ordinary.generated.yaml);
  });

  it("restores the previous configuration when a non-TUN restart fails", async () => {
    const f = fixture();
    const ordinary = {
      ...f.configuration,
      settings: { ...f.settings, tun: disabledTun(f.settings.tun) },
    };
    await f.lifecycle.apply(ordinary);
    const replacement = {
      ...ordinary,
      generated: { ...ordinary.generated, yaml: "rules: ['MATCH,REJECT']\n" },
    };
    const starts = f.core.starts;
    let failures = 1;
    f.core.onStart = () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("Core exited during startup");
      }
    };
    await assert.rejects(f.lifecycle.apply(replacement), (error: unknown) => {
      if (!(error instanceof CoreStartError)) return false;
      assert.match(error.message, /Core exited during startup/);
      assert.equal(error.restored, ordinary);
      assert.ok(error.cause instanceof Error);
      return true;
    });
    assert.equal(f.core.running, true);
    assert.equal(f.core.starts, starts + 2);
    assert.equal(f.lifecycle.configuration(), ordinary);
    assert.equal(fs.readFileSync(f.layout.configFile, "utf8"), ordinary.generated.yaml);
  });

  it("reports both failures when the previous configuration cannot be restored", async () => {
    const f = fixture();
    const ordinary = {
      ...f.configuration,
      settings: { ...f.settings, tun: disabledTun(f.settings.tun) },
    };
    await f.lifecycle.apply(ordinary);
    const replacement = {
      ...ordinary,
      generated: { ...ordinary.generated, yaml: "rules: ['MATCH,REJECT']\n" },
    };
    let attempts = 0;
    f.core.onStart = () => {
      attempts += 1;
      throw new Error(attempts === 1 ? "candidate failed" : "restore failed");
    };
    await assert.rejects(f.lifecycle.apply(replacement), (error: unknown) => {
      if (!(error instanceof CoreStartError)) return false;
      assert.match(error.message, /candidate failed/);
      assert.match(error.message, /restoring the previous configuration failed/);
      assert.match(error.message, /restore failed/);
      assert.equal(error.restored, undefined);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, "candidate failed");
      return true;
    });
    assert.equal(f.core.running, false);
    assert.equal(f.lifecycle.configuration(), undefined);
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

describe("TUN guard reconcile", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-tun-guard-test-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture({ tun = true } = {}) {
    const layout = sashLayout(root);
    const settings = testSettings({
      tun: { ...defaultTunSettings(), enable: tun, device: "Meta" },
    });
    const core = new FakeCoreSupervisor(layout, settings);
    const calls: Array<{ verb: string; device?: string }> = [];
    let failWith: Error | undefined;
    const tunGuard = {
      supported: true,
      reconcile: (verb: "setup" | "teardown", options?: { device?: string }) => {
        calls.push({ verb, ...(options?.device ? { device: options.device } : {}) });
        return failWith ? Promise.reject(failWith) : Promise.resolve();
      },
      lastResult: () => undefined,
    };
    const proxy: SystemProxyController = {
      apply: async () => {},
      release: async () => {},
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
      reloadConfig: async () => {},
      tun: new TunService(
        {
          mechanism: "capabilities",
          inspect: async () => ({ state: "ready" as const }),
          install: async () => {},
          uninstall: async () => {},
        },
        layout,
      ),
      tunGuard,
    });
    const configuration = {
      generated: { yaml: "rules: ['MATCH,DIRECT']\n", proxyCount: 0, source: "default" as const },
      settings: { ...settings },
      profile: null,
    };
    return {
      layout,
      settings,
      core,
      calls,
      lifecycle,
      configuration,
      tunGuard,
      setFailure: (error: Error | undefined) => {
        failWith = error;
      },
    };
  }

  async function settle() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("converges setup with the configured device after a TUN Core starts", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    await settle();
    assert.deepEqual(f.calls, [{ verb: "setup", device: f.settings.tun.device }]);
  });

  it("converges teardown after a non-TUN Core starts", async () => {
    const f = fixture({ tun: false });
    await f.lifecycle.apply(f.configuration);
    await settle();
    assert.deepEqual(f.calls, [{ verb: "teardown" }]);
  });

  it("does not teardown in the intermediate stop of a replacement", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    await settle();
    f.calls.length = 0;
    await f.lifecycle.apply(f.configuration);
    await settle();
    assert.deepEqual(f.calls, [{ verb: "setup", device: f.settings.tun.device }]);
  });

  it("does not teardown during crash recovery and converges setup again", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    await settle();
    f.calls.length = 0;
    f.core.running = false;
    await f.lifecycle.restoreCoreSession(f.configuration);
    await settle();
    const verbs = f.calls.map((call) => call.verb);
    assert.equal(verbs.includes("teardown"), false);
    assert.deepEqual(f.calls, [{ verb: "setup", device: "Meta" }]);
  });

  it("switches to teardown when the replacement disables TUN", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    await settle();
    f.calls.length = 0;
    const ordinary = {
      ...f.configuration,
      settings: { ...f.settings, tun: disabledTun(f.settings.tun) },
    };
    await f.lifecycle.apply(ordinary);
    await settle();
    assert.deepEqual(f.calls, [{ verb: "teardown" }]);
  });

  it("tears down on the final stop but not on a plain stop", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    await settle();
    f.calls.length = 0;
    await f.lifecycle.stop();
    assert.deepEqual(f.calls, []);
    await f.lifecycle.apply(f.configuration);
    await settle();
    f.calls.length = 0;
    await f.lifecycle.stop({ final: true });
    assert.deepEqual(f.calls, [{ verb: "teardown" }]);
  });

  it("does not fail the start when the guard reconcile rejects", async () => {
    const f = fixture();
    f.setFailure(new Error("boom"));
    await f.lifecycle.apply(f.configuration);
    await settle();
    assert.equal(f.core.running, true);
    assert.deepEqual(f.calls, [{ verb: "setup", device: f.settings.tun.device }]);
  });

  it("reconverges setup after a hot reload while TUN stays enabled", async () => {
    const f = fixture();
    await f.lifecycle.apply(f.configuration);
    await settle();
    f.calls.length = 0;
    await f.lifecycle.reload(f.configuration);
    await settle();
    assert.deepEqual(f.calls, [{ verb: "setup", device: "Meta" }]);
  });

  it("does not reconcile after a hot reload when TUN is disabled", async () => {
    const f = fixture({ tun: false });
    await f.lifecycle.apply(f.configuration);
    await settle();
    f.calls.length = 0;
    await f.lifecycle.reload(f.configuration);
    await settle();
    assert.deepEqual(f.calls, []);
  });

  it("keeps running without a guard wired in", async () => {
    const layout = sashLayout(root);
    const settings = testSettings();
    const core = new FakeCoreSupervisor(layout, settings);
    const proxy: SystemProxyController = {
      apply: async () => {},
      release: async () => {},
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
      tun: new TunService(unsupportedTunPlatform(), layout),
    });
    const configuration = {
      generated: { yaml: "rules: []\n", proxyCount: 0, source: "default" as const },
      settings: { ...settings },
      profile: null,
    };
    await lifecycle.apply(configuration);
    assert.equal(core.running, true);
    await lifecycle.stop({ final: true });
    assert.equal(core.running, false);
  });
});

describe("runtime delta", () => {
  const settings = testSettings();
  const noChanges = {
    profile: false,
    mixedPort: false,
    allowLan: false,
    tun: false,
    runtimeUnknown: false,
  };
  const changes = (patch: Partial<typeof noChanges>) => ({ ...noChanges, ...patch });
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
      pendingChanges: noChanges,
    });
  });
  it("treats an unknown runtime as pending without demanding a restart", () => {
    assert.deepEqual(runtimeDelta(undefined, { profile: null, settings }), {
      pending: true,
      restartRequired: false,
      pendingChanges: changes({ runtimeUnknown: true }),
    });
  });
  it("separates a new profile revision from restart-requiring changes", () => {
    const target = { profile: { id: "7", revision: 3 }, settings };
    assert.deepEqual(
      runtimeDelta(applied({}, { id: "7", revision: 2, name: "p", url: "" }), target),
      {
        pending: true,
        restartRequired: false,
        pendingChanges: changes({ profile: true }),
      },
    );
    assert.deepEqual(runtimeDelta(applied({ mixedPort: 19099 }), target), {
      pending: true,
      restartRequired: true,
      pendingChanges: changes({ profile: true, mixedPort: true }),
    });
    assert.deepEqual(runtimeDelta(applied({ allowLan: true }), target), {
      pending: true,
      restartRequired: true,
      pendingChanges: changes({ profile: true, allowLan: true }),
    });
  });
  it("notices a selection that was never applied", () => {
    assert.deepEqual(runtimeDelta(applied(), { profile: { id: "7", revision: 1 }, settings }), {
      pending: true,
      restartRequired: false,
      pendingChanges: changes({ profile: true }),
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
        pendingChanges: noChanges,
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
        pendingChanges: changes({ tun: true }),
      },
    );
  });
});

describe("restart-requiring settings", () => {
  const settings = testSettings();
  it("ignores advanced TUN field edits while TUN is disabled on both sides", () => {
    const edited = {
      ...settings.tun,
      stack: "gvisor" as const,
      strictRoute: true,
      dnsHijack: ["any:53"],
    };
    assert.equal(restartRequiringSettingsChanged(settings, { ...settings, tun: edited }), false);
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
      restartRequiringSettingsChanged(
        { ...settings, tun: appliedTun },
        { ...settings, tun: edited },
      ),
      true,
    );
  });
  it("notices a TUN enable flip", () => {
    assert.equal(
      restartRequiringSettingsChanged(settings, {
        ...settings,
        tun: { ...settings.tun, enable: true },
      }),
      true,
    );
    assert.equal(
      restartRequiringSettingsChanged(
        { ...settings, tun: { ...settings.tun, enable: true } },
        settings,
      ),
      true,
    );
  });
});
