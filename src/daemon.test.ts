import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { request } from "undici";
import { writeInstallRecord } from "./core.js";
import {
  type CoreState,
  type CoreSupervisor,
  createDaemonServer,
  type DaemonInstance,
  type DaemonScheduler,
} from "./daemon.js";
import type { GeneratedConfig, SubscriptionFetch } from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { loadProfiles, NEVER_UPDATED, type ProfileMeta, saveProfiles } from "./profiles.js";
import { DEFAULT_SETTINGS, type SashSettings } from "./settings.js";
import type { SystemProxyState } from "./sysproxy.js";
import type { SystemProxyController } from "./system-proxy-manager.js";

describe("daemon server", () => {
  let tmpDir: string;
  let layout: SashLayout;
  let settings: SashSettings;
  let instance: DaemonInstance | undefined;
  let boundPort: number;
  let mockCoreServer: http.Server | undefined;
  let mockCorePort: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-daemon-test-"));
    layout = sashLayout(tmpDir);
    settings = {
      ...DEFAULT_SETTINGS,
      daemonSecret: "test-daemon-secret-1234567890",
      controller: "127.0.0.1:9090",
      secret: "test-core-secret-1234567890",
    };
  });

  afterEach(async () => {
    if (instance) {
      await instance.close().catch(() => undefined);
      instance = undefined;
    }
    if (mockCoreServer) {
      await new Promise<void>((resolve) => mockCoreServer?.close(() => resolve()));
      mockCoreServer = undefined;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  function fakeSystemProxy(): SystemProxyController {
    let applied = false;
    const state = (): SystemProxyState => ({ supported: true, enabled: applied });
    return {
      apply: async () => {
        applied = true;
      },
      release: async () => {
        applied = false;
      },
      recover: async () => {
        applied = false;
      },
      inspect: () => ({ applied, state: state() }),
      isApplied: () => applied,
      getState: state,
    };
  }

  async function startServer(
    overrides: {
      supervisor?: CoreSupervisor;
      systemProxy?: SystemProxyController;
      fetchProfile?: (url: string) => Promise<SubscriptionFetch>;
      validateConfig?: (generated: GeneratedConfig) => Promise<void> | void;
      scheduler?: DaemonScheduler;
    } = {},
  ): Promise<DaemonInstance> {
    const fakeSupervisor: CoreSupervisor =
      overrides.supervisor ??
      ({
        isRunning: () => false,
        ownedCoreSnapshot: () => undefined,
        ownsCore: () => false,
        status: async (): Promise<CoreState> => ({ running: false }),
        start: async () => ({ pid: 9999, version: "v1.0.0" }),
        stop: async () => {},
        restart: async () => ({ pid: 10000, version: "v1.0.0" }),
        cleanStaleCore: async () => {},
      } as unknown as CoreSupervisor);

    const inst = createDaemonServer({
      layout,
      settings,
      supervisor: fakeSupervisor,
      systemProxy: overrides.systemProxy ?? fakeSystemProxy(),
      fetchProfileFn: overrides.fetchProfile,
      validateConfigFn: overrides.validateConfig ?? (() => undefined),
      scheduler: overrides.scheduler,
    });

    await new Promise<void>((resolve, reject) => {
      inst.server.listen(0, "127.0.0.1", () => resolve());
      inst.server.once("error", reject);
    });

    const addr = inst.server.address();
    boundPort = typeof addr === "object" && addr ? addr.port : 0;
    instance = inst;
    return inst;
  }

  async function apiRequest(
    pathname: string,
    opts: {
      method?: string;
      body?: unknown;
      rawBody?: string;
      token?: string;
      webToken?: string;
      origin?: string;
    } = {},
  ) {
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = {};
    if (opts.origin) headers.Origin = opts.origin;
    if (opts.webToken) {
      headers["X-Sash-Token"] = opts.webToken;
    } else if (opts.token !== undefined) {
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    } else {
      headers.Authorization = `Bearer ${settings.daemonSecret}`;
    }
    let bodyStr: string | undefined;
    if (opts.rawBody !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = opts.rawBody;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(opts.body);
    }

    const res = await request(`http://127.0.0.1:${boundPort}${pathname}`, {
      method: method as "GET" | "POST" | "DELETE" | "PATCH",
      headers,
      body: bodyStr,
    });
    const text = await res.body.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { statusCode: res.statusCode, data: json };
  }

  async function rawHttpRequest(target: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: boundPort });
      let response = "";
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (response) resolve(response);
        else reject(new Error("HTTP connection closed without a response"));
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error("Raw HTTP request timed out"));
      }, 3000);
      socket.on("connect", () => {
        socket.write(
          `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${boundPort}\r\nConnection: close\r\n\r\n`,
        );
      });
      socket.on("data", (chunk) => {
        response += chunk.toString("utf8");
      });
      socket.on("end", finish);
      socket.on("close", finish);
      socket.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async function rawWebSocketUpgrade(
    pathname: string,
    headers: Record<string, string> = {},
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: boundPort });
      let response = "";
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("WebSocket upgrade timed out"));
      }, 3000);
      socket.on("connect", () => {
        const requestHeaders = {
          Host: `127.0.0.1:${boundPort}`,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
        };
        const lines = Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`);
        socket.write(`GET ${pathname} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      });
      socket.on("data", (chunk) => {
        response += chunk.toString("utf8");
        if (!response.includes("\r\n\r\n")) return;
        clearTimeout(timeout);
        socket.destroy();
        resolve(response);
      });
      socket.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  describe("request error boundary", () => {
    it("returns 400 for an invalid request target and keeps serving", async () => {
      await startServer();

      const response = await rawHttpRequest("http://");
      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.match(response, /Invalid request target/);

      const health = await apiRequest("/sash/health", { token: "" });
      assert.equal(health.statusCode, 200);
    });

    it("returns 400 for an invalid WebSocket target and keeps serving", async () => {
      await startServer();

      const response = await rawWebSocketUpgrade("http://", {
        Authorization: `Bearer ${settings.daemonSecret}`,
      });
      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.match(response, /Invalid request target/);

      const health = await apiRequest("/sash/health", { token: "" });
      assert.equal(health.statusCode, 200);
    });
  });

  describe("JSON request contracts", () => {
    it("returns 400 for malformed and non-object JSON without leaking TypeErrors", async () => {
      await startServer();

      for (const rawBody of ["{", "null", "[]", '"value"']) {
        const response = await apiRequest("/sash/settings", {
          method: "PATCH",
          rawBody,
        });
        assert.equal(response.statusCode, 400, rawBody);
        const message = (response.data as { error: string }).error;
        assert.doesNotMatch(message, /TypeError|Cannot read/i, rawBody);
      }

      const health = await apiRequest("/sash/health", { token: "" });
      assert.equal(health.statusCode, 200);
    });

    it("returns 413 for an oversized JSON object and keeps serving", async () => {
      await startServer();
      const response = await apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "tun", padding: "x".repeat(1024 * 1024) },
      });
      assert.equal(response.statusCode, 413);
      assert.match((response.data as { error: string }).error, /Request body too large/);

      const health = await apiRequest("/sash/health", { token: "" });
      assert.equal(health.statusCode, 200);
    });
  });

  describe("authentication and namespaces", () => {
    it("allows unauthenticated GET /sash/health returning token and pid", async () => {
      await startServer();
      const res = await apiRequest("/sash/health", { token: "" });
      assert.equal(res.statusCode, 200);
      const data = res.data as { ok: boolean; token: string; pid: number };
      assert.equal(data.ok, true);
      assert.equal(typeof data.token, "string");
      assert.equal(data.pid, process.pid);
    });

    it("allows public status reads without exposing control secrets", async () => {
      await startServer();
      const res = await apiRequest("/sash/status", { token: "" });
      assert.equal(res.statusCode, 200);
      const data = res.data as {
        daemon: { pid: number };
        settings: Record<string, unknown>;
      };
      assert.equal(data.daemon.pid, process.pid);
      assert.equal("secret" in data.settings, false);
      assert.equal("daemonSecret" in data.settings, false);
    });

    it("rejects unauthenticated mutations and accepts the per-boot WebUI token", async () => {
      const inst = await startServer();
      const denied = await apiRequest("/core/start", { method: "POST", token: "" });
      assert.equal(denied.statusCode, 401);

      const allowed = await apiRequest("/sash/proxy/disable", {
        method: "POST",
        token: "",
        webToken: inst.token,
      });
      assert.equal(allowed.statusCode, 200);
    });

    it("rejects browser mutations from non-loopback Origins", async () => {
      await startServer();
      const denied = await apiRequest("/core/start", {
        method: "POST",
        origin: "https://attacker.example",
      });
      assert.equal(denied.statusCode, 403);
      assert.deepEqual(denied.data, { error: "Invalid Origin header" });
    });
  });

  describe("GET /sash/status", () => {
    it("returns daemon, core, system proxy, and canonical installed version", async () => {
      writeInstallRecord(
        { coreVersion: "v1.2.3", installedAt: "2026-01-01T00:00:00.000Z" },
        layout,
      );
      await startServer();
      const res = await apiRequest("/sash/status");
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
      await startServer({ supervisor });

      const res = await apiRequest("/sash/status");
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
        recover: async () => {
          if (!applied) return;
          disabledCalls++;
          applied = false;
        },
        inspect: () => ({
          applied,
          state: { supported: true, enabled: applied, server: "127.0.0.1:7890" },
        }),
        isApplied: () => applied,
        getState: () => ({
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

      await startServer({ supervisor: fakeSupervisor, systemProxy });

      // Core not running -> enable should fail
      const failRes = await apiRequest("/sash/proxy/enable", { method: "POST" });
      assert.equal(failRes.statusCode, 400);

      // Start core first
      await apiRequest("/core/start", { method: "POST" });

      const enableRes = await apiRequest("/sash/proxy/enable", { method: "POST" });
      assert.equal(enableRes.statusCode, 200);
      assert.equal(enabledCalls, 1);

      // GET /sash/proxy should show enabled
      const stateRes = await apiRequest("/sash/proxy");
      assert.equal(stateRes.statusCode, 200);
      const state = stateRes.data as { desired: boolean; applied: boolean };
      assert.equal(state.desired, true);
      assert.equal(state.applied, true);

      // Disable
      const disableRes = await apiRequest("/sash/proxy/disable", { method: "POST" });
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
        recover: async () => {},
        inspect: () => ({ applied: true, state: { supported: true, enabled: true } }),
        isApplied: () => true,
        getState: () => ({ supported: true, enabled: true }),
      };
      await startServer({
        systemProxy,
        fetchProfile: async () => {
          fetches++;
          return {
            doc: { rules: ["MATCH,DIRECT"] },
            yamlText: "rules:\n  - MATCH,DIRECT\n",
          };
        },
      });

      const response = await apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "system-proxy", value: "off" },
      });
      assert.equal(response.statusCode, 500);
      assert.equal(fetches, 0);
      assert.equal(
        (JSON.parse(fs.readFileSync(layout.settingsFile, "utf8")) as { systemProxy: boolean })
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
        recover: async () => {},
        inspect: () => ({ applied: false, state: { supported: true, enabled: false } }),
        isApplied: () => false,
        getState: () => ({ supported: true, enabled: false }),
      };
      const inst = await startServer({ systemProxy, scheduler });

      const failed = await apiRequest("/sash/shutdown", { method: "POST" });
      assert.equal(failed.statusCode, 500);
      assert.equal(inst.server.listening, true);
      assert.equal(clears, 0);

      const closed = new Promise<void>((resolve) => inst.server.once("close", resolve));
      const successful = await apiRequest("/sash/shutdown", { method: "POST" });
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
      const inst = await startServer({ supervisor });

      const maintenance = apiRequest("/sash/maintenance/shutdown", { method: "POST" });
      await stopEntered;
      const inserted = await apiRequest("/core/start", { method: "POST" });
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
        recover: async () => {},
        inspect: () => ({
          applied: false,
          state: { supported: true, enabled: false },
        }),
        isApplied: () => false,
        getState: () => ({ supported: true, enabled: false }),
      };
      const inst = await startServer({ systemProxy });

      await assert.rejects(inst.close(), /transient restore failure/);
      await inst.close();

      assert.equal(releases, 2);
      assert.equal(inst.server.listening, false);
    });
  });

  describe("PATCH /sash/settings", () => {
    it("applies managed keys and writes settings file", async () => {
      await startServer();
      const res = await apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "tun", value: "on" },
      });
      assert.equal(res.statusCode, 200);

      const raw = JSON.parse(fs.readFileSync(layout.settingsFile, "utf8"));
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
      await startServer({ supervisor });

      const res = await apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "tun", value: "on" },
      });

      assert.equal(res.statusCode, 500);
      assert.match(
        (res.data as { error: string }).error,
        /TUN did not become active.*sash stop.*sash config set tun on/s,
      );
      assert.equal(restartCalls, 2);
      const raw = JSON.parse(fs.readFileSync(layout.settingsFile, "utf8")) as { tun: boolean };
      assert.equal(raw.tun, false);
      assert.doesNotMatch(fs.readFileSync(layout.configFile, "utf8"), /^tun:/m);
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
      await startServer({
        validateConfig: async (generated) => {
          if (!generated.yaml.includes("mixed-port: 18888")) return;
          entered?.();
          await validationRelease;
        },
      });

      const patch = apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "mixed-port", value: "18888" },
      });
      await validationEntered;
      const beforeCommit = await apiRequest("/sash/settings");
      assert.equal(
        (beforeCommit.data as { settings: { mixedPort: number } }).settings.mixedPort,
        17890,
      );
      release?.();
      assert.equal((await patch).statusCode, 200);
    });

    it("rejects unknown keys with 400 containing message", async () => {
      await startServer();
      const res = await apiRequest("/sash/settings", {
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
        recover: async () => {
          if (!applied) return;
          disabled += 1;
          applied = false;
        },
        inspect: () => ({
          applied,
          state: { supported: true, enabled: applied },
        }),
        isApplied: () => applied,
        getState: () => ({ supported: true, enabled: applied }),
      };
      await startServer({ supervisor, systemProxy });
      await apiRequest("/sash/proxy/enable", { method: "POST" });

      const res = await apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "mixed-port", value: "18888" },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(enabledPorts, [17890, 18888]);
      assert.equal(disabled, 1);
    });

    it("restores settings when the generated config fails Core validation", async () => {
      await startServer({
        validateConfig: (generated) => {
          if (generated.yaml.includes("mixed-port: 18888")) {
            throw new Error("invalid generated config");
          }
        },
      });

      const res = await apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "mixed-port", value: "18888" },
      });

      assert.equal(res.statusCode, 500);
      const persisted = JSON.parse(fs.readFileSync(layout.settingsFile, "utf8")) as {
        mixedPort: number;
      };
      assert.equal(persisted.mixedPort, 17890);
      assert.equal(fs.existsSync(layout.configFile), false);
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
      await startServer({ supervisor });

      const res = await apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "mixed-port", value: "18888" },
      });

      assert.equal(res.statusCode, 500);
      const persisted = JSON.parse(fs.readFileSync(layout.settingsFile, "utf8")) as {
        mixedPort: number;
      };
      assert.equal(persisted.mixedPort, 17890);
      assert.match(fs.readFileSync(layout.configFile, "utf8"), /mixed-port: 17890/);
      assert.equal(running, true);
      assert.equal(recoveryStarts, 1);
    });
  });

  describe("web UI serving", () => {
    it("redirects GET /ui to /ui/ preserving the query string", async () => {
      await startServer();
      const res = await request(`http://127.0.0.1:${boundPort}/ui?tab=proxies`);
      await res.body.text();
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, "/ui/?tab=proxies");
    });

    it("serves index.html at /ui/ without a redirect", async () => {
      fs.mkdirSync(layout.uiDir, { recursive: true });
      fs.writeFileSync(path.join(layout.uiDir, "index.html"), "<html>ui</html>");
      await startServer();
      const res = await request(`http://127.0.0.1:${boundPort}/ui/`);
      const text = await res.body.text();
      assert.equal(res.statusCode, 200);
      assert.match(text, /<html>ui<\/html>/);
    });

    it("isolates dashboard documents, SPA fallbacks, and assets from framing", async () => {
      fs.mkdirSync(layout.uiDir, { recursive: true });
      fs.writeFileSync(path.join(layout.uiDir, "index.html"), "<html>ui</html>");
      fs.writeFileSync(path.join(layout.uiDir, "app.js"), "export {};\n");
      await startServer();

      for (const pathname of ["/ui/", "/ui/profiles", "/ui/app.js"]) {
        const res = await request(`http://127.0.0.1:${boundPort}${pathname}`);
        await res.body.text();
        assert.equal(res.statusCode, 200, pathname);
        assert.equal(res.headers["content-security-policy"], "frame-ancestors 'none'", pathname);
        assert.equal(res.headers["x-frame-options"], "DENY", pathname);
        assert.equal(res.headers["x-content-type-options"], "nosniff", pathname);
        assert.equal(res.headers["referrer-policy"], "no-referrer", pathname);
      }
    });

    it("supports HEAD for dashboard assets without streaming a body", async () => {
      fs.mkdirSync(layout.uiDir, { recursive: true });
      fs.writeFileSync(path.join(layout.uiDir, "index.html"), "<html>ui</html>");
      await startServer();
      const res = await request(`http://127.0.0.1:${boundPort}/ui/`, { method: "HEAD" });
      assert.equal(res.statusCode, 200);
      assert.equal(await res.body.text(), "");
    });
  });

  describe("/sash/profiles API", () => {
    const subUrl = "https://good.test/sub";
    const subYaml = "proxies:\n  - name: node-a\n    type: direct\nrules:\n  - MATCH,DIRECT\n";

    function mockFetchProfile(url: string): Promise<SubscriptionFetch> {
      if (url.includes("bad")) return Promise.reject(new Error("boom"));
      return Promise.resolve({
        doc: { proxies: [{ name: "node-a", type: "direct" }], rules: ["MATCH,DIRECT"] },
        yamlText: subYaml,
        name: "mock-sub",
        subInfo: { upload: 1, download: 2, total: 100 },
      });
    }

    it("reads an incomplete profile request body before entering the mutation lock", async () => {
      await startServer({ fetchProfile: mockFetchProfile });
      const body = JSON.stringify({ url: subUrl });
      const socket = net.createConnection({ host: "127.0.0.1", port: boundPort });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        `POST /sash/profiles HTTP/1.1\r\nHost: 127.0.0.1:${boundPort}\r\nAuthorization: Bearer ${settings.daemonSecret}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 5)}`,
      );

      const stop = await apiRequest("/core/stop", { method: "POST" });
      assert.equal(stop.statusCode, 200);
      socket.destroy();
    });

    it("allows runtime mutations while a profile fetch is still preparing", async () => {
      let releaseFetch: (() => void) | undefined;
      let fetchStartedResolve: (() => void) | undefined;
      const fetchStarted = new Promise<void>((resolve) => {
        fetchStartedResolve = resolve;
      });
      await startServer({
        fetchProfile: async () => {
          fetchStartedResolve?.();
          await new Promise<void>((resolve) => {
            releaseFetch = resolve;
          });
          return mockFetchProfile(subUrl);
        },
      });

      const pendingProfile = apiRequest("/sash/profiles", {
        method: "POST",
        body: { url: subUrl },
      });
      await fetchStarted;
      const stop = await apiRequest("/core/stop", { method: "POST" });
      assert.equal(stop.statusCode, 200);
      releaseFetch?.();
      assert.equal((await pendingProfile).statusCode, 200);
    });

    it("starts empty", async () => {
      await startServer();
      const res = await apiRequest("/sash/profiles");
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.data, { activeId: null, profiles: [] });
    });

    it("POST downloads, auto-activates the first profile and stores metadata", async () => {
      await startServer({ fetchProfile: mockFetchProfile });
      const res = await apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } });
      assert.equal(res.statusCode, 200);
      const data = res.data as {
        profile: { id: string; name: string; url: string };
        activated: boolean;
        proxyCount: number;
      };
      assert.equal(data.activated, true);
      assert.equal(data.profile.name, "mock-sub");
      assert.equal(data.proxyCount, 1);

      const list = (await apiRequest("/sash/profiles")).data as {
        activeId: string;
        profiles: Array<{ id: string; subInfo?: { total: number } }>;
      };
      assert.equal(list.profiles.length, 1);
      assert.equal(list.activeId, data.profile.id);
      assert.equal(list.profiles[0]?.subInfo?.total, 100);

      assert.ok(fs.readFileSync(layout.configFile, "utf8").includes("node-a"));
      const statusAfterAdd = (await apiRequest("/sash/status")).data as {
        revisions: { profiles: number };
      };
      assert.equal(statusAfterAdd.revisions.profiles, 1);

      // Re-downloading the same URL updates in place instead of duplicating.
      const again = await apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } });
      assert.equal(again.statusCode, 200);
      const list2 = (await apiRequest("/sash/profiles")).data as { profiles: unknown[] };
      assert.equal(list2.profiles.length, 1);
      const statusAfterUpdate = (await apiRequest("/sash/status")).data as {
        revisions: { profiles: number };
      };
      assert.equal(statusAfterUpdate.revisions.profiles, 2);
    });

    it("a second download does not steal the active selection", async () => {
      await startServer({ fetchProfile: mockFetchProfile });
      const first = (await apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } }))
        .data as { profile: { id: string } };
      const second = await apiRequest("/sash/profiles", {
        method: "POST",
        body: { url: "https://good.test/other" },
      });
      assert.equal((second.data as { activated: boolean }).activated, false);
      const list = (await apiRequest("/sash/profiles")).data as {
        activeId: string;
        profiles: unknown[];
      };
      assert.equal(list.profiles.length, 2);
      assert.equal(list.activeId, first.profile.id);
    });

    it("PUT /sash/profiles/active switches and recompiles; unknown id 404s", async () => {
      await startServer({ fetchProfile: mockFetchProfile });
      await apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } });
      const second = (
        await apiRequest("/sash/profiles", {
          method: "POST",
          body: { url: "https://good.test/other" },
        })
      ).data as { profile: { id: string } };

      const sel = await apiRequest("/sash/profiles/active", {
        method: "PUT",
        body: { id: second.profile.id },
      });
      assert.equal(sel.statusCode, 200);
      assert.equal((sel.data as { activeId: string }).activeId, second.profile.id);

      const missing = await apiRequest("/sash/profiles/active", {
        method: "PUT",
        body: { id: "1234567890123" },
      });
      assert.equal(missing.statusCode, 404);

      // Deselect reverts to the DIRECT-only default config.
      const off = await apiRequest("/sash/profiles/active", { method: "PUT", body: { id: null } });
      assert.equal(off.statusCode, 200);
      assert.ok(!fs.readFileSync(layout.configFile, "utf8").includes("node-a"));
    });

    it("import validates content; local profiles cannot be URL-updated", async () => {
      await startServer({ fetchProfile: mockFetchProfile });
      const bad = await apiRequest("/sash/profiles/import", {
        method: "POST",
        body: { name: "junk", content: "not: a clash config" },
      });
      assert.equal(bad.statusCode, 400);

      const good = await apiRequest("/sash/profiles/import", {
        method: "POST",
        body: { name: "local", content: subYaml },
      });
      assert.equal(good.statusCode, 200);
      const imported = (good.data as { profile: { id: string; url: string } }).profile;
      assert.equal(imported.url, "");

      const upd = await apiRequest(`/sash/profiles/${imported.id}/update`, { method: "POST" });
      assert.equal(upd.statusCode, 400);

      const missing = await apiRequest("/sash/profiles/1234567890123/update", { method: "POST" });
      assert.equal(missing.statusCode, 404);
    });

    it("update-all reports per-profile failures and keeps the active one hot", async () => {
      await startServer({ fetchProfile: mockFetchProfile });
      await apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } });
      // Seed a remote profile without fetching (meta-only, content pending).
      const index = loadProfiles(layout);
      const bad: ProfileMeta = {
        id: "9999999999999",
        name: "bad",
        url: "https://bad.test/x",
        intervalHours: 24,
        createdAt: new Date().toISOString(),
        updatedAt: NEVER_UPDATED,
      };
      saveProfiles({ ...index, profiles: [...index.profiles, bad] }, layout);

      const res = await apiRequest("/sash/profiles/update-all", { method: "POST" });
      assert.equal(res.statusCode, 200);
      const data = res.data as {
        ok: boolean;
        updated: number;
        failed: Array<{ name: string; error: string }>;
        proxyCount?: number;
      };
      assert.equal(data.ok, false);
      assert.equal(data.updated, 1);
      assert.equal(data.failed.length, 1);
      assert.equal(data.failed[0]?.error, "boom");
      // Active profile updated → recompiled even without a running core.
      assert.equal(data.proxyCount, 1);

      const list = (await apiRequest("/sash/profiles")).data as {
        profiles: Array<{ name: string; url: string; lastError?: string }>;
      };
      const badProfile = list.profiles.find((p) => p.url === "https://bad.test/x");
      assert.equal(badProfile?.lastError, "boom");
    });

    it("DELETE removes the file and deselects when active", async () => {
      await startServer({ fetchProfile: mockFetchProfile });
      const created = (
        await apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } })
      ).data as { profile: { id: string } };

      const del = await apiRequest(`/sash/profiles/${created.profile.id}`, { method: "DELETE" });
      assert.equal(del.statusCode, 200);
      assert.equal((del.data as { wasActive: boolean }).wasActive, true);

      const list = (await apiRequest("/sash/profiles")).data as {
        activeId: string | null;
        profiles: unknown[];
      };
      assert.equal(list.activeId, null);
      assert.equal(list.profiles.length, 0);
      assert.equal(fs.existsSync(`${layout.profilesDir}/${created.profile.id}.yaml`), false);

      const missing = await apiRequest("/sash/profiles/1234567890123", { method: "DELETE" });
      assert.equal(missing.statusCode, 404);
    });
  });

  describe("/core/api/* reverse proxy", () => {
    it("rejects every unauthenticated Core GET before opening an upstream request", async () => {
      let upstreamRequests = 0;
      mockCoreServer = http.createServer((_req, res) => {
        upstreamRequests++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
      await new Promise<void>((resolve) => {
        mockCoreServer?.listen(0, "127.0.0.1", () => resolve());
      });
      const address = mockCoreServer.address();
      mockCorePort = typeof address === "object" && address ? address.port : 0;
      settings.controller = `127.0.0.1:${mockCorePort}`;
      await startServer();

      const delay = await apiRequest(
        "/core/api/proxies/DIRECT/delay?url=http%3A%2F%2F192.168.1.1%2Faction",
        { token: "" },
      );
      const fallback = await apiRequest("/version", { token: "" });

      assert.equal(delay.statusCode, 401);
      assert.equal(fallback.statusCode, 401);
      assert.equal(upstreamRequests, 0);
    });

    it("injects the core authorization and strips daemon control credentials", async () => {
      let receivedAuth: string | undefined;
      let receivedWebToken: string | undefined;
      let receivedPath: string | undefined;

      // Start a mock Core external-controller server
      mockCoreServer = http.createServer((req, res) => {
        receivedAuth = req.headers.authorization;
        receivedWebToken = req.headers["x-sash-token"] as string | undefined;
        receivedPath = req.url;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "v1.19.30-meta" }));
      });

      await new Promise<void>((resolve) => {
        mockCoreServer?.listen(0, "127.0.0.1", () => resolve());
      });

      const addr = mockCoreServer.address();
      mockCorePort = typeof addr === "object" && addr ? addr.port : 0;
      settings.controller = `127.0.0.1:${mockCorePort}`;

      const inst = await startServer();

      // Call /core/api/version with the WebUI credential via sashd.
      const res = await apiRequest("/core/api/version", {
        token: "",
        webToken: inst.token,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(receivedPath, "/version");
      assert.equal(receivedAuth, `Bearer ${settings.secret}`);
      assert.equal(receivedWebToken, undefined);
      assert.deepEqual(res.data, { version: "v1.19.30-meta" });

      const invalidPrefix = await apiRequest("/core/apiX/version");
      assert.equal(invalidPrefix.statusCode, 404);
    });

    it("rejects unauthenticated WebSocket upgrades", async () => {
      await startServer();
      const response = await rawWebSocketUpgrade("/core/api/logs");
      assert.match(response, /^HTTP\/1\.1 401 Unauthorized WebSocket request/);
    });

    it("closes the upstream when the client disconnects before the 101 response", async () => {
      let resolveAccepted: (() => void) | undefined;
      const accepted = new Promise<void>((resolve) => {
        resolveAccepted = resolve;
      });
      let resolveUpstreamEnded: (() => void) | undefined;
      let rejectUpstreamEnded: ((reason: Error) => void) | undefined;
      const upstreamEnded = new Promise<void>((resolve, reject) => {
        resolveUpstreamEnded = resolve;
        rejectUpstreamEnded = reject;
      });
      let upstreamSocket: Duplex | undefined;
      mockCoreServer = http.createServer();
      mockCoreServer.on("upgrade", (_req, socket) => {
        upstreamSocket = socket;
        socket.once("end", () => resolveUpstreamEnded?.());
        socket.once("close", () => resolveUpstreamEnded?.());
        socket.on("readable", () => {
          while (socket.read() !== null) {
            // Consume until EOF so the peer close is observable.
          }
        });
        resolveAccepted?.();
      });
      await new Promise<void>((resolve) => {
        mockCoreServer?.listen(0, "127.0.0.1", () => resolve());
      });
      const address = mockCoreServer.address();
      mockCorePort = typeof address === "object" && address ? address.port : 0;
      settings.controller = `127.0.0.1:${mockCorePort}`;
      await startServer();

      const client = net.createConnection({ host: "127.0.0.1", port: boundPort });
      client.on("error", () => undefined);
      try {
        await new Promise<void>((resolve, reject) => {
          client.once("connect", resolve);
          client.once("error", reject);
        });
        client.write(
          "GET /core/api/logs HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${boundPort}\r\n` +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            `Authorization: Bearer ${settings.daemonSecret}\r\n\r\n`,
        );
        await accepted;
        client.destroy();

        const deadline = setTimeout(
          () => rejectUpstreamEnded?.(new Error("upstream WebSocket did not receive EOF")),
          1000,
        );
        try {
          await upstreamEnded;
        } finally {
          clearTimeout(deadline);
        }
        assert.equal(upstreamSocket?.readableEnded || upstreamSocket?.destroyed, true);
      } finally {
        client.destroy();
        upstreamSocket?.destroy();
      }
    });

    it("completes WebSocket auth negotiation without forwarding private protocols", async () => {
      let receivedProtocols: string | undefined;
      mockCoreServer = http.createServer();
      mockCoreServer.on("upgrade", (req, socket) => {
        receivedProtocols = req.headers["sec-websocket-protocol"];
        socket.end(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
        );
      });
      await new Promise<void>((resolve) => {
        mockCoreServer?.listen(0, "127.0.0.1", () => resolve());
      });
      const address = mockCoreServer.address();
      mockCorePort = typeof address === "object" && address ? address.port : 0;
      settings.controller = `127.0.0.1:${mockCorePort}`;

      const inst = await startServer();
      const response = await rawWebSocketUpgrade("/core/api/logs", {
        Origin: `http://127.0.0.1:${boundPort}`,
        "Sec-WebSocket-Protocol": `sash, sash-token.${inst.token}`,
      });

      assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
      assert.match(response, /\r\nsec-websocket-protocol: sash\r\n/i);
      assert.equal(receivedProtocols, undefined);
    });
  });
});
