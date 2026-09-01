import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { request } from "undici";
import { writeInstallRecord } from "./core.js";
import {
  type CoreState,
  type CoreSupervisor,
  createDaemonServer,
  type DaemonInstance,
  type SysproxyAdapter,
} from "./daemon.js";
import type { GeneratedConfig, SubscriptionFetch } from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { addProfile } from "./profiles.js";
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
      fetchProfile?: (url: string) => Promise<SubscriptionFetch>;
      validateConfig?: (generated: GeneratedConfig) => Promise<void> | void;
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
      fetchProfileFn: overrides.fetchProfile,
      validateConfigFn: overrides.validateConfig ?? (() => undefined),
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
      webToken?: string;
    } = {},
  ) {
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = {};
    if (opts.webToken) {
      headers["X-Sash-Token"] = opts.webToken;
    } else if (opts.token !== undefined) {
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

    it("rebinds an enabled system proxy after mixed-port restarts the core", async () => {
      let running = true;
      const enabledPorts: number[] = [];
      let disabled = 0;
      const supervisor = {
        isRunning: () => running,
        status: async (): Promise<CoreState> => ({ running }),
        start: async () => ({ pid: 1234 }),
        stop: async () => {
          running = false;
        },
        restart: async () => {
          running = true;
          return { pid: 1234 };
        },
        cleanStaleCore: async () => {},
      } as unknown as CoreSupervisor;
      const sysproxy: SysproxyAdapter = {
        enable: async ({ port }) => {
          enabledPorts.push(port);
        },
        disable: async () => {
          disabled += 1;
        },
        getState: () => ({ supported: true, enabled: enabledPorts.length > disabled }),
      };
      await startServer({ supervisor, sysproxy });
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
        status: async (): Promise<CoreState> => ({ running }),
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

      // Re-downloading the same URL updates in place instead of duplicating.
      const again = await apiRequest("/sash/profiles", { method: "POST", body: { url: subUrl } });
      assert.equal(again.statusCode, 200);
      const list2 = (await apiRequest("/sash/profiles")).data as { profiles: unknown[] };
      assert.equal(list2.profiles.length, 1);
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
      addProfile({ name: "bad", url: "https://bad.test/x" }, layout);

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

    it("authenticates WebSockets and strips the daemon token protocol upstream", async () => {
      let receivedProtocols: string | undefined;
      mockCoreServer = http.createServer();
      mockCoreServer.on("upgrade", (req, socket) => {
        receivedProtocols = req.headers["sec-websocket-protocol"];
        socket.end("HTTP/1.1 400 Test Complete\r\nConnection: close\r\n\r\n");
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
        "Sec-WebSocket-Protocol": `sash-token.${inst.token}`,
      });

      assert.match(response, /^HTTP\/1\.1 400 Test Complete/);
      assert.equal(receivedProtocols, undefined);
    });
  });
});
