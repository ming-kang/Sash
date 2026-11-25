import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { createCoreRunner } from "../core-runner.js";
import { GEOX_MIRROR_SETS } from "../mihomo-config.js";
import { sashLayout } from "../paths.js";
import { classifyProcessIdentityAsync } from "../process.js";
import { RuntimeLifecycle } from "../runtime-lifecycle.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { CoreSupervisor } from "../supervisor.js";
import type { SystemProxyController } from "../sysproxy/manager.js";
import { FakeCoreSupervisor, testSettings } from "../testing/state.js";
import { TunService, unsupportedTunPlatform } from "../tun-service.js";
import { type CoreEngine, mihomoEngine } from "./index.js";

describe("mihomoEngine", () => {
  it("launches the Core with its data directory and managed config file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-engine-"));
    try {
      const layout = sashLayout(root);
      assert.deepEqual(mihomoEngine.spawnArguments(layout), [
        "-d",
        layout.root,
        "-f",
        layout.configFile,
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes the engine's geodata mirrors, failure classifiers and test budget", () => {
    assert.equal(mihomoEngine.id, "mihomo");
    assert.equal(mihomoEngine.geodata.mirrorSets, GEOX_MIRROR_SETS);
    assert.equal(typeof mihomoEngine.geodata.testTimeoutMs, "number");
    const geodataError = new Error(
      "initial GeoIP: can't download MMDB: context deadline exceeded (country.mmdb)",
    );
    assert.equal(mihomoEngine.geodata.isDownloadFailure(geodataError), true);
    assert.equal(mihomoEngine.geodata.fileForFailure(geodataError), "country.mmdb");
    assert.equal(mihomoEngine.geodata.isDownloadFailure(new Error("syntax error")), false);
  });

  it("creates a controller client for the engine's external controller", () => {
    const api = mihomoEngine.api("127.0.0.1:19090", "secret");
    for (const method of ["isReachable", "version", "setMode", "reloadConfig", "delay"] as const) {
      assert.equal(typeof api[method], "function", `api.${method}`);
    }
  });
});

describe("CoreEngine injection", () => {
  function stubApi(overrides: Partial<ReturnType<CoreEngine["api"]>> = {}) {
    return {
      isReachable: async () => false,
      version: async () => "v-stub",
      setMode: async () => {},
      reloadConfig: async () => {},
      delay: async () => ({
        state: "ok" as const,
        delayMs: 1,
        error: null,
        name: "DIRECT",
        url: "https://www.gstatic.com/generate_204",
        timeoutMs: 5000,
        testedAt: new Date(0).toISOString(),
      }),
      ...overrides,
    };
  }

  function stubEngine(overrides: Partial<CoreEngine> = {}): CoreEngine {
    return { ...mihomoEngine, id: "stub", ...overrides };
  }

  it("CoreSupervisor probes health through the injected engine api", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-engine-sup-"));
    const layout = sashLayout(root);
    fs.mkdirSync(path.dirname(layout.coreExe), { recursive: true });
    fs.writeFileSync(layout.coreExe, "fake-core");
    fs.mkdirSync(path.dirname(layout.configFile), { recursive: true });
    fs.writeFileSync(layout.configFile, "mixed-port: 1\n");

    const children: ChildProcess[] = [];
    const calls: string[] = [];
    const engine = stubEngine({
      api: (controller, secret) => {
        calls.push(`api:${controller}:${secret}`);
        return stubApi({
          isReachable: async () => true,
          version: async () => "v-stub-engine",
        });
      },
    });
    const settings = { ...DEFAULT_SETTINGS, controller: "127.0.0.1:1", secret: "s" };
    const supervisor = new CoreSupervisor({
      layout,
      settings: () => settings,
      engine,
      runner: createCoreRunner({
        layout,
        engine,
        spawnFn: () => {
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
            windowsHide: true,
          });
          children.push(child);
          return child;
        },
        classifyIdentityFn: (pid) => classifyProcessIdentityAsync(pid, process.execPath),
      }),
      waitHealthyMs: 8000,
    });

    try {
      const result = await supervisor.start();
      assert.equal(result.version, "v-stub-engine");
      assert.ok(calls.some((c) => c.startsWith("api:127.0.0.1:1:s")));
    } finally {
      await supervisor.stop().catch(() => {});
      for (const child of children) child.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("RuntimeLifecycle refuses to replace a controller the engine reports reachable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-engine-life-"));
    try {
      const layout = sashLayout(root);
      const settings = testSettings({ systemProxy: false });
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
      const engine = stubEngine({
        api: () => stubApi({ isReachable: async () => true }),
      });
      const lifecycle = new RuntimeLifecycle({
        layout,
        supervisor: core,
        systemProxy: proxy,
        settings: () => settings,
        engine,
        tun: new TunService(unsupportedTunPlatform(), layout),
      });
      await assert.rejects(
        lifecycle.apply({
          generated: { yaml: "rules: []\n", proxyCount: 0, source: "default" },
          settings: { ...settings },
          profile: null,
        }),
        /unowned Core controller is still active/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("RuntimeLifecycle reloads through the injected engine api", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-engine-reload-"));
    try {
      const layout = sashLayout(root);
      const settings = testSettings({ systemProxy: false });
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
      const reloads: string[] = [];
      const engine = stubEngine({
        api: () =>
          stubApi({
            reloadConfig: async (path: string) => {
              reloads.push(path);
            },
          }),
      });
      const lifecycle = new RuntimeLifecycle({
        layout,
        supervisor: core,
        systemProxy: proxy,
        settings: () => settings,
        engine,
        tun: new TunService(unsupportedTunPlatform(), layout),
      });
      const configuration = {
        generated: { yaml: "rules: []\n", proxyCount: 0, source: "default" as const },
        settings: { ...settings },
        profile: null,
      };
      await lifecycle.apply(configuration);
      await lifecycle.reload(configuration);
      assert.deepEqual(reloads, [layout.configFile]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
