import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { writeInstallRecord } from "./core.js";
import type { CoreState, CoreSupervisor, DaemonScheduler } from "./daemon.js";
import { useDaemonTestHarness } from "./daemon-test-harness.test.js";
import type { SystemProxyController } from "./system-proxy-manager.js";

describe("daemon server", () => {
  const h = useDaemonTestHarness();

  describe("GET /sash/status", () => {
    it("returns daemon, core, system proxy, and canonical installed version", async () => {
      writeInstallRecord(
        { coreVersion: "v1.2.3", installedAt: "2026-01-01T00:00:00.000Z" },
        h.layout,
      );
      await h.startServer();
      const res = await h.apiRequest("/sash/status");
      assert.equal(res.statusCode, 200);
      const data = res.data as {
        daemon: { pid: number };
        core: { running: boolean; version?: string };
        systemProxy: { desired: boolean };
      };
      assert.equal(data.daemon.pid, process.pid);
      assert.equal(data.core.running, false);
      assert.equal(data.core.version, "v1.2.3");
      assert.equal(data.systemProxy.desired, false);
    });

    it("keeps health responsive while async proxy inspection is pending", async () => {
      let inspectFresh: boolean | undefined;
      let inspectEnteredResolve: (() => void) | undefined;
      const inspectEntered = new Promise<void>((resolve) => {
        inspectEnteredResolve = resolve;
      });
      let releaseInspect: (() => void) | undefined;
      const inspectBlocked = new Promise<void>((resolve) => {
        releaseInspect = resolve;
      });
      const systemProxy: SystemProxyController = {
        apply: async () => {},
        release: async () => {},
        inspect: async (fresh) => {
          inspectFresh = fresh;
          inspectEnteredResolve?.();
          await inspectBlocked;
          return {
            applied: false,
            state: { supported: true, enabled: false },
            appliedKnown: true,
            stateKnown: true,
          };
        },
        isApplied: async () => false,
        getState: async () => ({ supported: true, enabled: false }),
      };
      await h.startServer({ systemProxy });

      const status = h.apiRequest("/sash/status?fresh=1");
      await inspectEntered;
      const health = await h.apiRequest("/sash/health");
      assert.equal(health.statusCode, 200);
      releaseInspect?.();
      assert.equal((await status).statusCode, 200);
      assert.equal(inspectFresh, true);
    });

    it("reports actual TUN state independently from the desired setting", async () => {
      let running = true;
      const supervisor = {
        isRunning: () => running,
        status: async (): Promise<CoreState> => ({
          running,
          healthy: running,
          pid: 4321,
          tunActive: true,
        }),
        stop: async () => {
          running = false;
        },
        cleanStaleCore: async () => {},
      } as unknown as CoreSupervisor;
      await h.startServer({ supervisor });

      const res = await h.apiRequest("/sash/status");
      assert.equal(res.statusCode, 200);
      const data = res.data as {
        core: { tunActive?: boolean };
        settings: { tun: boolean };
      };
      assert.equal(data.settings.tun, false);
      assert.equal(data.core.tunActive, true);
    });
  });

  describe("system proxy management", () => {
    it("persists system proxy enable/disable and dispatches to the controller", async () => {
      let enabledCalls = 0;
      let disabledCalls = 0;
      let applied = false;
      const systemProxy: SystemProxyController = {
        apply: async () => {
          enabledCalls++;
          applied = true;
        },
        release: async () => {
          if (!applied) return;
          disabledCalls++;
          applied = false;
        },
        inspect: async () => ({
          applied,
          appliedKnown: true,
          stateKnown: true,
          state: { supported: true, enabled: applied, server: "127.0.0.1:7890" },
        }),
        isApplied: async () => applied,
        getState: async () => ({
          supported: true,
          enabled: applied,
          server: "127.0.0.1:7890",
        }),
      };

      let running = false;
      let generation = 0;
      const fakeSupervisor = {
        isRunning: () => running,
        ownedCoreSnapshot: () => (running ? { pid: 1234, generation } : undefined),
        ownsCore: (snapshot: { pid: number; generation: number }) =>
          running && snapshot.pid === 1234 && snapshot.generation === generation,
        status: async (): Promise<CoreState> => ({ running, healthy: running }),
        start: async () => {
          running = true;
          generation++;
          return { pid: 1234, version: "v1.0.0" };
        },
        stop: async () => {
          running = false;
          generation++;
        },
        restart: async () => {
          running = true;
          generation++;
          return { pid: 1234, version: "v1.0.0" };
        },
        cleanStaleCore: async () => {},
      } as unknown as CoreSupervisor;

      await h.startServer({ supervisor: fakeSupervisor, systemProxy });

      // Core not running -> enable should fail
      const failRes = await h.apiRequest("/sash/proxy/enable", { method: "POST" });
      assert.equal(failRes.statusCode, 400);

      // Start core first
      await h.apiRequest("/core/start", { method: "POST" });

      const enableRes = await h.apiRequest("/sash/proxy/enable", { method: "POST" });
      assert.equal(enableRes.statusCode, 200);
      assert.equal(enabledCalls, 1);

      // GET /sash/proxy should show enabled
      const stateRes = await h.apiRequest("/sash/proxy");
      assert.equal(stateRes.statusCode, 200);
      const state = stateRes.data as { desired: boolean; applied: boolean };
      assert.equal(state.desired, true);
      assert.equal(state.applied, true);

      // Disable
      const disableRes = await h.apiRequest("/sash/proxy/disable", { method: "POST" });
      assert.equal(disableRes.statusCode, 200);
      assert.equal(disabledCalls, 1);
    });

    it("persists proxy-off despite release failure without fetching or validating profiles", async () => {
      let fetches = 0;
      let releases = 0;
      const systemProxy: SystemProxyController = {
        apply: async () => {},
        release: async () => {
          if (++releases === 1) throw new Error("release failed");
        },
        inspect: async () => ({
          appliedKnown: true,
          stateKnown: true,
          applied: true,
          state: { supported: true, enabled: true },
        }),
        isApplied: async () => true,
        getState: async () => ({ supported: true, enabled: true }),
      };
      await h.startServer({
        systemProxy,
        fetchProfile: async () => {
          fetches++;
          return {
            doc: { rules: ["MATCH,DIRECT"] },
            yamlText: "rules:\n  - MATCH,DIRECT\n",
          };
        },
      });

      const response = await h.apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "system-proxy", value: "off" },
      });
      assert.equal(response.statusCode, 500);
      assert.equal(fetches, 0);
      assert.equal(
        (JSON.parse(fs.readFileSync(h.layout.settingsFile, "utf8")) as { systemProxy: boolean })
          .systemProxy,
        false,
      );
    });

    it("returns shutdown cleanup failures without stopping the listener or scheduler", async () => {
      let releases = 0;
      let clears = 0;
      const timer = { unref: () => timer } as unknown as NodeJS.Timeout;
      const scheduler: DaemonScheduler = {
        setInterval: ((_: () => void) => timer) as typeof setInterval,
        clearInterval: (() => {
          clears++;
        }) as typeof clearInterval,
        setTimeout: ((_: () => void) => timer) as typeof setTimeout,
        clearTimeout: (() => {
          clears++;
        }) as typeof clearTimeout,
      };
      const systemProxy: SystemProxyController = {
        apply: async () => {},
        release: async () => {
          if (++releases === 1) throw new Error("restore failed");
        },
        inspect: async () => ({
          appliedKnown: true,
          stateKnown: true,
          applied: false,
          state: { supported: true, enabled: false },
        }),
        isApplied: async () => false,
        getState: async () => ({ supported: true, enabled: false }),
      };
      const inst = await h.startServer({ systemProxy, scheduler });

      const failed = await h.apiRequest("/sash/shutdown", { method: "POST" });
      assert.equal(failed.statusCode, 500);
      assert.equal(inst.server.listening, true);
      assert.equal(clears, 0);

      const closed = new Promise<void>((resolve) => inst.server.once("close", resolve));
      const successful = await h.apiRequest("/sash/shutdown", { method: "POST" });
      assert.equal(successful.statusCode, 200);
      await closed;
      assert.equal(inst.server.listening, false);
      assert.equal(clears, 2);
    });

    it("atomically snapshots maintenance state and rejects later mutations", async () => {
      let running = true;
      let starts = 0;
      let stopEnteredResolve: (() => void) | undefined;
      let releaseStop: (() => void) | undefined;
      const stopEntered = new Promise<void>((resolve) => {
        stopEnteredResolve = resolve;
      });
      const supervisor = {
        isRunning: () => running,
        ownedCoreSnapshot: () => (running ? { pid: 1234, generation: 1 } : undefined),
        ownsCore: () => running,
        status: async (): Promise<CoreState> => ({ running, healthy: running, pid: 1234 }),
        start: async () => {
          starts++;
          running = true;
          return { pid: 1234 };
        },
        stop: async () => {
          stopEnteredResolve?.();
          await new Promise<void>((resolve) => {
            releaseStop = resolve;
          });
          running = false;
        },
        restart: async () => ({ pid: 1234 }),
        cleanStaleCore: async () => {},
      } as unknown as CoreSupervisor;
      const inst = await h.startServer({ supervisor });

      const maintenance = h.apiRequest("/sash/maintenance/shutdown", { method: "POST" });
      await stopEntered;
      const inserted = await h.apiRequest("/core/start", { method: "POST" });
      assert.equal(inserted.statusCode, 503);
      assert.equal(starts, 0);

      const closed = new Promise<void>((resolve) => inst.server.once("close", resolve));
      releaseStop?.();
      const result = await maintenance;
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.data, { ok: true, coreWasRunning: true });
      await closed;
    });

    it("allows daemon close to be retried after a transient cleanup failure", async () => {
      let releases = 0;
      const systemProxy: SystemProxyController = {
        apply: async () => {},
        release: async () => {
          releases++;
          if (releases === 1) throw new Error("transient restore failure");
        },
        inspect: async () => ({
          applied: false,
          state: { supported: true, enabled: false },
          appliedKnown: true,
          stateKnown: true,
        }),
        isApplied: async () => false,
        getState: async () => ({ supported: true, enabled: false }),
      };
      const inst = await h.startServer({ systemProxy });

      await assert.rejects(inst.close(), /transient restore failure/);
      await inst.close();

      assert.equal(releases, 2);
      assert.equal(inst.server.listening, false);
    });
  });
});
