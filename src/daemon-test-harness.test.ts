import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "node:test";
import { request } from "undici";
import type { AutostartController } from "./autostart.js";
import { writeInstallRecord } from "./core-install-record.js";
import { coreBinarySha256 } from "./core-integrity.js";
import {
  type CoreSupervisor,
  createDaemonServer,
  type DaemonDeps,
  type DaemonInstance,
  type DaemonScheduler,
} from "./daemon.js";
import type { SubscriptionFetch } from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import type { SashSettings } from "./settings.js";
import type { SystemProxyState } from "./sysproxy.js";
import type { SystemProxyController } from "./system-proxy-manager.js";
import { FakeCoreSupervisor, testSettings } from "./test-state.test.js";

export interface DaemonServerOverrides {
  packageRoot?: string;
  installCore?: boolean;
  stageCore?: DaemonDeps["stageCoreFn"];
  supervisor?: CoreSupervisor;
  systemProxy?: SystemProxyController;
  autostart?: AutostartController;
  fetchProfile?: (url: string, signal?: AbortSignal) => Promise<SubscriptionFetch>;
  validateConfig?: DaemonDeps["validateConfigFn"];
  scheduler?: DaemonScheduler;
}

export interface DaemonApiRequestOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  token?: string;
  webToken?: string;
  origin?: string;
}

export interface DaemonApiResponse {
  statusCode: number;
  data: unknown;
}

export class DaemonTestHarness {
  private tmpDir: string | undefined;
  layout!: SashLayout;
  settings!: SashSettings;
  instance: DaemonInstance | undefined;
  boundPort = 0;
  mockCoreServer: http.Server | undefined;
  mockCorePort = 0;

  setup(): void {
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-daemon-test-"));
    this.layout = sashLayout(this.tmpDir);
    this.settings = testSettings();
    this.instance = undefined;
    this.boundPort = 0;
    this.mockCoreServer = undefined;
    this.mockCorePort = 0;
  }

  async cleanup(): Promise<void> {
    if (this.instance) {
      await this.instance.close().catch(() => undefined);
      this.instance = undefined;
    }
    if (this.mockCoreServer) {
      const server = this.mockCoreServer;
      this.mockCoreServer = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (!this.tmpDir) return;
    try {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    } finally {
      this.tmpDir = undefined;
    }
  }

  fakeSystemProxy(): SystemProxyController {
    let applied = false;
    const state = (): SystemProxyState => ({ supported: true, enabled: applied });
    return {
      apply: async () => {
        applied = true;
      },
      release: async () => {
        applied = false;
      },
      inspect: async () => ({
        applied,
        state: state(),
        appliedKnown: true,
        stateKnown: true,
      }),
      isApplied: async () => applied,
      getState: async () => state(),
    };
  }

  async startServer(overrides: DaemonServerOverrides = {}, port = 0): Promise<DaemonInstance> {
    if (overrides.installCore !== false && !fs.existsSync(this.layout.coreExe)) {
      fs.mkdirSync(this.layout.binDir, { recursive: true });
      fs.writeFileSync(this.layout.coreExe, "v1.0.0-core");
      writeInstallRecord(
        {
          coreVersion: "v1.0.0",
          installedAt: "2026-09-08T00:00:00.000Z",
          sha256: coreBinarySha256(this.layout.coreExe),
        },
        this.layout,
      );
    }
    const fakeSupervisor: CoreSupervisor =
      overrides.supervisor ?? new FakeCoreSupervisor(this.layout, this.settings);

    const instance = createDaemonServer({
      layout: this.layout,
      packageRoot: overrides.packageRoot,
      settings: this.settings,
      supervisor: fakeSupervisor,
      systemProxy: overrides.systemProxy ?? this.fakeSystemProxy(),
      autostart: overrides.autostart ?? {
        inspect: async () => ({ state: "off", canEnable: true, reason: null }),
        set: async () => {
          throw new Error("An autostart test adapter is required for writes");
        },
      },
      fetchProfileFn: overrides.fetchProfile,
      validateConfigFn: overrides.validateConfig ?? (() => undefined),
      controllerProbe: async () => false,
      stageCoreFn:
        overrides.stageCore ??
        (async () => {
          throw new Error("A Core download adapter is required in tests");
        }),
      verifyCoreFn: (exe, version) => {
        if (fs.readFileSync(exe, "utf8") !== `${version}-core`)
          throw new Error("Core version mismatch");
      },
      scheduler: overrides.scheduler,
    });

    await new Promise<void>((resolve, reject) => {
      instance.server.listen(port, "127.0.0.1", resolve);
      instance.server.once("error", reject);
    });

    const address = instance.server.address();
    this.boundPort = typeof address === "object" && address ? address.port : 0;
    this.instance = instance;
    return instance;
  }

  async apiRequest(
    pathname: string,
    options: DaemonApiRequestOptions = {},
  ): Promise<DaemonApiResponse> {
    const method = options.method ?? "GET";
    const headers: Record<string, string> = {};
    if (options.origin) headers.Origin = options.origin;
    if (options.webToken) {
      headers["X-Sash-Token"] = options.webToken;
    } else if (options.token !== undefined) {
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
    } else {
      headers.Authorization = `Bearer ${this.settings.daemonSecret}`;
    }

    let body: string | undefined;
    if (options.rawBody !== undefined) {
      headers["Content-Type"] = "application/json";
      body = options.rawBody;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await request(`http://127.0.0.1:${this.boundPort}${pathname}`, {
      method: method as "GET" | "POST" | "DELETE" | "PATCH",
      headers,
      body,
    });
    const text = await response.body.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { statusCode: response.statusCode, data };
  }

  /** Mint a real WebUI session token through the bootstrap exchange. */
  async mintWebSession(): Promise<string> {
    const bootstrap = await this.apiRequest("/sash/web/bootstrap", { method: "POST" });
    assert.equal(bootstrap.statusCode, 200);
    const bootstrapToken = (bootstrap.data as { token?: unknown }).token;
    assert.equal(typeof bootstrapToken, "string");
    const session = await this.apiRequest("/sash/web/session", {
      method: "POST",
      token: "",
      body: { token: bootstrapToken },
    });
    assert.equal(session.statusCode, 200);
    const sessionToken = (session.data as { token?: unknown }).token;
    assert.equal(typeof sessionToken, "string");
    return sessionToken as string;
  }

  rawHttpRequest(
    target: string,
    options: { method?: string; headers?: Record<string, string> } = {},
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: this.boundPort });
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
        const requestHeaders = {
          Host: `127.0.0.1:${this.boundPort}`,
          Connection: "close",
          ...options.headers,
        };
        const lines = Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`);
        socket.write(
          `${options.method ?? "GET"} ${target} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`,
        );
      });
      socket.on("data", (chunk) => {
        response += chunk.toString("utf8");
      });
      socket.on("end", finish);
      socket.on("close", finish);
      socket.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  rawWebSocketUpgrade(
    pathname: string,
    headers: Record<string, string> = {},
    method = "GET",
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: this.boundPort });
      let response = "";
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("WebSocket upgrade timed out"));
      }, 3000);
      socket.on("connect", () => {
        const requestHeaders = {
          Host: `127.0.0.1:${this.boundPort}`,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
        };
        const lines = Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`);
        socket.write(`${method} ${pathname} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      });
      socket.on("data", (chunk) => {
        response += chunk.toString("utf8");
        if (!response.includes("\r\n\r\n")) return;
        clearTimeout(timeout);
        socket.destroy();
        resolve(response);
      });
      socket.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}

export function useDaemonTestHarness(): DaemonTestHarness {
  const harness = new DaemonTestHarness();
  beforeEach(() => harness.setup());
  afterEach(() => harness.cleanup());
  return harness;
}
