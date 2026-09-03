import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { CoreState, CoreSupervisor } from "./daemon.js";
import { useDaemonTestHarness } from "./daemon-test-harness.test.js";
import type { ProfileMeta } from "./profiles.js";
import { saveProfiles } from "./profiles.js";
import type { SystemProxyController } from "./system-proxy-manager.js";

describe("daemon server", () => {
  const h = useDaemonTestHarness();

  describe("core lifecycle preparation", () => {
    it("re-prepares once when the active source changes before restart", async () => {
      const yamlA = "proxies:\n  - name: node-a\n    type: direct\nrules:\n  - MATCH,DIRECT\n";
      const yamlB = "proxies:\n  - name: node-b\n    type: direct\nrules:\n  - MATCH,DIRECT\n";
      const profile: ProfileMeta = {
        id: "1",
        name: "local",
        url: "",
        intervalHours: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const profileFile = path.join(h.layout.profilesDir, `${profile.id}.yaml`);
      fs.mkdirSync(h.layout.profilesDir, { recursive: true });
      fs.writeFileSync(profileFile, yamlA);
      saveProfiles({ activeId: profile.id, profiles: [profile] }, h.layout);

      let validationEnteredResolve: (() => void) | undefined;
      const validationEntered = new Promise<void>((resolve) => {
        validationEnteredResolve = resolve;
      });
      let releaseValidation: (() => void) | undefined;
      const validationBlocked = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      let validations = 0;
      let restarts = 0;
      const supervisor = {
        isRunning: () => true,
        ownedCoreSnapshot: () => ({ pid: 1234, generation: 1 }),
        ownsCore: () => true,
        status: async (): Promise<CoreState> => ({ running: true, healthy: true, pid: 1234 }),
        start: async () => ({ pid: 1234 }),
        stop: async () => {},
        restart: async () => {
          restarts += 1;
          return { pid: 1234 };
        },
        cleanStaleCore: async () => {},
      } as unknown as CoreSupervisor;
      await h.startServer({
        supervisor,
        validateConfig: async () => {
          validations += 1;
          if (validations !== 1) return;
          validationEnteredResolve?.();
          await validationBlocked;
        },
      });

      const restarting = h.apiRequest("/core/restart", { method: "POST" });
      await validationEntered;
      fs.writeFileSync(profileFile, yamlB);
      releaseValidation?.();

      const response = await restarting;
      assert.equal(response.statusCode, 200);
      assert.equal(validations, 2);
      assert.equal(restarts, 1);
      assert.match(fs.readFileSync(h.layout.configFile, "utf8"), /node-b/);
    });

    it("returns 409 after the bounded restart preparation retry is exhausted", async () => {
      const yamlA = "proxies:\n  - name: node-a\n    type: direct\nrules:\n  - MATCH,DIRECT\n";
      const yamlB = "proxies:\n  - name: node-b\n    type: direct\nrules:\n  - MATCH,DIRECT\n";
      const profile: ProfileMeta = {
        id: "1",
        name: "local",
        url: "",
        intervalHours: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const profileFile = path.join(h.layout.profilesDir, `${profile.id}.yaml`);
      fs.mkdirSync(h.layout.profilesDir, { recursive: true });
      fs.writeFileSync(profileFile, yamlA);
      saveProfiles({ activeId: profile.id, profiles: [profile] }, h.layout);

      let validations = 0;
      let restarts = 0;
      const supervisor = {
        isRunning: () => true,
        restart: async () => {
          restarts += 1;
          return { pid: 1234 };
        },
        stop: async () => {},
      } as unknown as CoreSupervisor;
      await h.startServer({
        supervisor,
        validateConfig: () => {
          validations += 1;
          fs.writeFileSync(profileFile, validations === 1 ? yamlB : yamlA);
        },
      });

      const response = await h.apiRequest("/core/restart", { method: "POST" });

      assert.equal(response.statusCode, 409);
      assert.match((response.data as { error: string }).error, /content changed/);
      assert.equal(validations, 2);
      assert.equal(restarts, 0);
    });
  });

  describe("PATCH /sash/settings", () => {
    it("applies managed keys and writes settings file", async () => {
      await h.startServer();
      const res = await h.apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "tun", value: "on" },
      });
      assert.equal(res.statusCode, 200);

      const raw = JSON.parse(fs.readFileSync(h.layout.settingsFile, "utf8"));
      assert.equal(raw.tun, true);
    });

    it("rejects and rolls back an online TUN enable that remains inactive", async () => {
      let running = true;
      let restartCalls = 0;
      const supervisor = {
        isRunning: () => running,
        restart: async () => {
          restartCalls++;
          return { pid: 1234, tunActive: false };
        },
        stop: async () => {
          running = false;
        },
        cleanStaleCore: async () => {},
      } as unknown as CoreSupervisor;
      await h.startServer({ supervisor });

      const res = await h.apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "tun", value: "on" },
      });

      assert.equal(res.statusCode, 500);
      assert.match(
        (res.data as { error: string }).error,
        /TUN did not become active.*sash config set tun on.*sash restart/s,
      );
      assert.equal(restartCalls, 2);
      const raw = JSON.parse(fs.readFileSync(h.layout.settingsFile, "utf8")) as { tun: boolean };
      assert.equal(raw.tun, false);
      assert.doesNotMatch(fs.readFileSync(h.layout.configFile, "utf8"), /^tun:/m);
    });

    it("keeps GET settings on the committed snapshot while candidate validation is delayed", async () => {
      let entered: (() => void) | undefined;
      let release: (() => void) | undefined;
      const validationEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const validationRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      await h.startServer({
        validateConfig: async (generated) => {
          if (!generated.yaml.includes("mixed-port: 18888")) return;
          entered?.();
          await validationRelease;
        },
      });

      const patch = h.apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "mixed-port", value: "18888" },
      });
      await validationEntered;
      const beforeCommit = await h.apiRequest("/sash/settings");
      assert.equal(
        (beforeCommit.data as { settings: { mixedPort: number } }).settings.mixedPort,
        17890,
      );
      release?.();
      assert.equal((await patch).statusCode, 200);
    });

    it("rejects unknown keys with 400 containing message", async () => {
      await h.startServer();
      const res = await h.apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "invalid-key", value: "value" },
      });
      assert.equal(res.statusCode, 400);
      assert.match((res.data as { error: string }).error, /unknown key/);
    });

    it("rebinds an enabled system proxy after mixed-port restarts the core", async () => {
      let running = true;
      let generation = 1;
      const enabledPorts: number[] = [];
      let disabled = 0;
      const supervisor = {
        isRunning: () => running,
        ownedCoreSnapshot: () => (running ? { pid: 1234, generation } : undefined),
        ownsCore: (snapshot: { pid: number; generation: number }) =>
          running && snapshot.pid === 1234 && snapshot.generation === generation,
        status: async (): Promise<CoreState> => ({ running, healthy: running }),
        start: async () => {
          running = true;
          generation++;
          return { pid: 1234 };
        },
        stop: async () => {
          running = false;
          generation++;
        },
        restart: async () => {
          running = true;
          generation++;
          return { pid: 1234 };
        },
        cleanStaleCore: async () => {},
      } as unknown as CoreSupervisor;
      let applied = false;
      const systemProxy: SystemProxyController = {
        apply: async ({ port }) => {
          enabledPorts.push(port);
          applied = true;
        },
        release: async () => {
          if (!applied) return;
          disabled += 1;
          applied = false;
        },
        inspect: async () => ({
          applied,
          appliedKnown: true,
          stateKnown: true,
          state: { supported: true, enabled: applied },
        }),
        isApplied: async () => applied,
        getState: async () => ({ supported: true, enabled: applied }),
      };
      await h.startServer({ supervisor, systemProxy });
      await h.apiRequest("/sash/proxy/enable", { method: "POST" });

      const res = await h.apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "mixed-port", value: "18888" },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(enabledPorts, [17890, 18888]);
      assert.equal(disabled, 1);
    });

    it("restores settings when the generated config fails Core validation", async () => {
      await h.startServer({
        validateConfig: (generated) => {
          if (generated.yaml.includes("mixed-port: 18888")) {
            throw new Error("invalid generated config");
          }
        },
      });

      const res = await h.apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "mixed-port", value: "18888" },
      });

      assert.equal(res.statusCode, 500);
      const persisted = JSON.parse(fs.readFileSync(h.layout.settingsFile, "utf8")) as {
        mixedPort: number;
      };
      assert.equal(persisted.mixedPort, 17890);
      assert.equal(fs.existsSync(h.layout.configFile), false);
    });

    it("restores the old config and runtime after a restart failure", async () => {
      let running = true;
      let recoveryStarts = 0;
      const supervisor = {
        isRunning: () => running,
        status: async (): Promise<CoreState> => ({ running, healthy: running }),
        start: async () => {
          running = true;
          recoveryStarts += 1;
          return { pid: 2222 };
        },
        stop: async () => {
          running = false;
        },
        restart: async () => {
          running = false;
          throw new Error("new runtime failed");
        },
        cleanStaleCore: async () => {},
      } as unknown as CoreSupervisor;
      await h.startServer({ supervisor });

      const res = await h.apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "mixed-port", value: "18888" },
      });

      assert.equal(res.statusCode, 500);
      const persisted = JSON.parse(fs.readFileSync(h.layout.settingsFile, "utf8")) as {
        mixedPort: number;
      };
      assert.equal(persisted.mixedPort, 17890);
      assert.match(fs.readFileSync(h.layout.configFile, "utf8"), /mixed-port: 17890/);
      assert.equal(running, true);
      assert.equal(recoveryStarts, 1);
    });
  });
});
