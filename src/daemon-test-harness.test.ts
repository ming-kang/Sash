import fs from "node:fs";
import type http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "node:test";
import { request } from "undici";
import {
  type CoreState,
  type CoreSupervisor,
  createDaemonServer,
  type DaemonInstance,
  type DaemonScheduler,
} from "./daemon.js";
import type { GeneratedConfig, SubscriptionFetch } from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { DEFAULT_SETTINGS, type SashSettings } from "./settings.js";
import type { SystemProxyState } from "./sysproxy.js";
import type { SystemProxyController } from "./system-proxy-manager.js";

export interface DaemonServerOverrides {
  supervisor?: CoreSupervisor;
  systemProxy?: SystemProxyController;
  fetchProfile?: (url: string) => Promise<SubscriptionFetch>;
  validateConfig?: (generated: GeneratedConfig) => Promise<void> | void;
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
    this.settings = {
      ...DEFAULT_SETTINGS,
      daemonSecret: "test-daemon-secret-1234567890",
      controller: "127.0.0.1:9090",
      secret: "test-core-secret-1234567890",
    };
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

  async startServer(overrides: DaemonServerOverrides = {}): Promise<DaemonInstance> {
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

    const instance = createDaemonServer({
      layout: this.layout,
      settings: this.settings,
      supervisor: fakeSupervisor,
      systemProxy: overrides.systemProxy ?? this.fakeSystemProxy(),
      fetchProfileFn: overrides.fetchProfile,
      validateConfigFn: overrides.validateConfig ?? (() => undefined),
      scheduler: overrides.scheduler,
    });

    await new Promise<void>((resolve, reject) => {
      instance.server.listen(0, "127.0.0.1", resolve);
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
