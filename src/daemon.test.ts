import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { request } from "undici";
import {
  type CoreState,
  type CoreSupervisor,
  createDaemonServer,
  type DaemonInstance,
  type SysproxyAdapter,
} from "./daemon.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { DEFAULT_SETTINGS, type SashSettings } from "./settings.js";
import type { SystemProxyState } from "./sysproxy.js";

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
      daemonPort: 0,
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

  async function startServer(
    overrides: {
      supervisor?: CoreSupervisor;
      sysproxy?: SysproxyAdapter;
      fetchSub?: (url: string) => Promise<Record<string, unknown>>;
    } = {},
  ): Promise<DaemonInstance> {
    const fakeSupervisor: CoreSupervisor =
      overrides.supervisor ??
      ({
        isRunning: () => false,
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
      sysproxy: overrides.sysproxy,
      fetchSubscriptionFn: overrides.fetchSub,
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
      token?: string;
    } = {},
  ) {
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) {
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    } else {
      headers.Authorization = `Bearer ${settings.daemonSecret}`;
    }
    let bodyStr: string | undefined;
    if (opts.body !== undefined) {
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

  describe("authentication and namespaces", () => {
    it("allows unauthenticated GET /sash/health returning token and pid", async () => {
      await startServer();
      const res = await apiRequest("/sash/health");
      assert.equal(res.statusCode, 200);
      const data = res.data as { ok: boolean; token: string; pid: number };
      assert.equal(data.ok, true);
      assert.equal(typeof data.token, "string");
      assert.equal(data.pid, process.pid);
    });

    it("allows direct local loopback access to /sash/status", async () => {
      await startServer();
      const res = await apiRequest("/sash/status");
      assert.equal(res.statusCode, 200);
      const data = res.data as { daemon: { pid: number } };
      assert.equal(data.daemon.pid, process.pid);
    });
  });

  describe("GET /sash/status", () => {
    it("returns daemon, core, system proxy, and settings state", async () => {
      await startServer();
      const res = await apiRequest("/sash/status");
      assert.equal(res.statusCode, 200);
      const data = res.data as {
        daemon: { pid: number };
        core: { running: boolean };
        systemProxy: { desired: boolean };
      };
      assert.equal(data.daemon.pid, process.pid);
      assert.equal(data.core.running, false);
      assert.equal(data.systemProxy.desired, false);
    });
  });

  describe("system proxy management", () => {
    it("persists system proxy enable/disable and dispatches to adapter", async () => {
      let enabledCalls = 0;
      let disabledCalls = 0;
      const fakeSysproxy: SysproxyAdapter = {
        enable: async () => {
          enabledCalls++;
        },
        disable: async () => {
          disabledCalls++;
        },
        getState: (): SystemProxyState => ({
          supported: true,
          enabled: enabledCalls > disabledCalls,
          server: "127.0.0.1:7890",
        }),
      };

      let running = false;
      const fakeSupervisor = {
        isRunning: () => running,
        status: async (): Promise<CoreState> => ({ running }),
        start: async () => {
          running = true;
          return { pid: 1234, version: "v1.0.0" };
        },
        stop: async () => {
          running = false;
        },
        restart: async () => ({ pid: 1234, version: "v1.0.0" }),
        cleanStaleCore: async () => {},
      } as unknown as CoreSupervisor;

      await startServer({ supervisor: fakeSupervisor, sysproxy: fakeSysproxy });

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

    it("rejects unknown keys with 400 containing message", async () => {
      await startServer();
      const res = await apiRequest("/sash/settings", {
        method: "PATCH",
        body: { key: "invalid-key", value: "value" },
      });
      assert.equal(res.statusCode, 400);
      assert.match((res.data as { error: string }).error, /unknown key/);
    });
  });

  describe("/core/api/* reverse proxy", () => {
    it("forwards HTTP requests to the core controller and injects authorization header", async () => {
      let receivedAuth: string | undefined;
      let receivedPath: string | undefined;

      // Start a mock Core external-controller server
      mockCoreServer = http.createServer((req, res) => {
        receivedAuth = req.headers.authorization;
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

      await startServer();

      // Call /core/api/version via sashd
      const res = await apiRequest("/core/api/version");
      assert.equal(res.statusCode, 200);
      assert.equal(receivedPath, "/version");
      assert.equal(receivedAuth, `Bearer ${settings.secret}`);
      assert.deepEqual(res.data, { version: "v1.19.30-meta" });
    });
  });
});
