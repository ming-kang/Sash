import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { MihomoApi } from "./api.js";
import { fetchSubscription, generateConfig } from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import {
  buildSanitizedEnv,
  classifyProcessIdentity,
  clearPidRecord,
  isProcessAlive,
  killProcessGracefully,
  readPidRecord,
  tailFile,
  writePidRecord,
} from "./process.js";
import {
  applyManagedKey,
  loadSettings,
  requiresCoreRestart,
  type SashSettings,
  saveSettings,
} from "./settings.js";
import {
  disableSystemProxy,
  enableSystemProxy,
  getSystemProxyState,
  type SystemProxyState,
} from "./sysproxy.js";

export interface DaemonPidRecord {
  pid: number;
  token: string;
  port: number;
  startedAt: string;
}

export interface CoreState {
  running: boolean;
  pid?: number;
  startedAt?: string;
  healthy?: boolean;
  version?: string;
}

export interface DaemonStatus {
  daemon: {
    pid: number;
    startedAt: string;
    port: number;
  };
  core: CoreState;
  systemProxy: {
    desired: boolean;
    applied: boolean;
    actual?: SystemProxyState;
  };
  settings: SashSettings;
}

export interface SysproxyAdapter {
  enable(opts: { host?: string; port: number }): Promise<void>;
  disable(): Promise<void>;
  getState(): SystemProxyState;
}

export interface CoreSupervisorOptions {
  layout: SashLayout;
  settings: () => SashSettings;
  spawnFn?: (layout: SashLayout, settings: SashSettings) => ChildProcess;
  waitHealthyMs?: number;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Supervise the child mihomo process directly. The child is NOT detached:
 * sashd holds its handle, monitors exit events, and cleans up state on exit.
 */
export class CoreSupervisor {
  private child: ChildProcess | null = null;
  private childStartedAt: string | undefined;
  private stopping = false;
  private readonly layout: SashLayout;
  private readonly getSettings: () => SashSettings;
  private readonly spawnFn: (layout: SashLayout, settings: SashSettings) => ChildProcess;
  private readonly waitHealthyMs: number;
  private readonly onExitCallback?: (code: number | null, signal: NodeJS.Signals | null) => void;

  constructor(opts: CoreSupervisorOptions) {
    this.layout = opts.layout;
    this.getSettings = opts.settings;
    this.waitHealthyMs = opts.waitHealthyMs ?? 10_000;
    this.onExitCallback = opts.onExit;
    this.spawnFn = opts.spawnFn ?? this.defaultSpawn.bind(this);
  }

  private defaultSpawn(layout: SashLayout, _settings: SashSettings): ChildProcess {
    fs.mkdirSync(layout.logsDir, { recursive: true });
    fs.mkdirSync(layout.stateDir, { recursive: true });

    const outFd = fs.openSync(layout.coreLogFile, "a", 0o600);
    let errFd: number;
    try {
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(layout.coreLogFile, 0o600);
        } catch {
          // ignore
        }
      }
      errFd = fs.openSync(layout.coreErrLogFile, "a", 0o600);
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(layout.coreErrLogFile, 0o600);
        } catch {
          // ignore
        }
      }
    } catch (err) {
      fs.closeSync(outFd);
      throw err;
    }

    const sanitizedEnv = buildSanitizedEnv();
    const child = spawn(layout.coreExe, ["-d", layout.root, "-f", layout.configFile], {
      cwd: layout.root,
      stdio: ["ignore", outFd, errFd],
      windowsHide: true,
      env: sanitizedEnv,
    });

    try {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    } catch {
      // ignore
    }

    return child;
  }

  async start(): Promise<{ pid: number; version?: string }> {
    if (this.child && isProcessAlive(this.child.pid ?? -1)) {
      throw new Error(`Core is already running (PID=${this.child.pid})`);
    }

    if (!fs.existsSync(this.layout.coreExe)) {
      throw new Error(`Core executable not found at ${this.layout.coreExe}`);
    }
    if (!fs.existsSync(this.layout.configFile)) {
      throw new Error(`Core config not found at ${this.layout.configFile}`);
    }

    this.stopping = false;
    const settings = this.getSettings();
    const child = this.spawnFn(this.layout, settings);
    const pid = child.pid;
    if (!pid) {
      throw new Error("Failed to start core process (no PID returned)");
    }

    this.child = child;
    this.childStartedAt = new Date().toISOString();
    writePidRecord(this.layout.pidFile, {
      pid,
      exe: this.layout.coreExe,
      startedAt: this.childStartedAt,
    });

    let spawnError: Error | undefined;
    child.once("error", (err) => {
      spawnError = err;
    });

    child.once("exit", (code, signal) => {
      const wasStopping = this.stopping;
      this.child = null;
      this.childStartedAt = undefined;
      clearPidRecord(this.layout.pidFile);
      if (!wasStopping) {
        this.onExitCallback?.(code, signal);
      }
    });

    const api = new MihomoApi(settings.controller, settings.secret);
    const deadline = Date.now() + this.waitHealthyMs;
    let version: string | undefined;

    while (Date.now() < deadline) {
      if (spawnError) {
        clearPidRecord(this.layout.pidFile);
        const details = tailFile(this.layout.coreErrLogFile, 20);
        throw new Error(
          `Failed to start core: ${spawnError.message}${details ? `\n${details}` : ""}`,
        );
      }

      if (!isProcessAlive(pid)) {
        clearPidRecord(this.layout.pidFile);
        const details = tailFile(this.layout.coreErrLogFile, 20);
        throw new Error(
          `Core exited during startup.${details ? `\nRecent errors:\n${details}` : ""}`,
        );
      }

      try {
        version = await api.version();
        return { pid, version };
      } catch {
        // keep polling
      }
      await sleep(250);
    }

    // Health check timed out
    this.stopping = true;
    await killProcessGracefully(pid, { timeoutMs: 3000 });
    clearPidRecord(this.layout.pidFile);
    this.child = null;
    const details = tailFile(this.layout.coreErrLogFile, 20);
    throw new Error(
      `Core started (PID=${pid}) but external-controller did not become healthy within ${this.waitHealthyMs}ms.${
        details ? `\nRecent errors:\n${details}` : ""
      }`,
    );
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child?.pid || !isProcessAlive(child.pid)) {
      this.child = null;
      clearPidRecord(this.layout.pidFile);
      return;
    }

    this.stopping = true;
    const pid = child.pid;
    await killProcessGracefully(pid, { timeoutMs: 8000 });
    this.child = null;
    this.childStartedAt = undefined;
    clearPidRecord(this.layout.pidFile);
  }

  async restart(): Promise<{ pid: number; version?: string }> {
    await this.stop();
    return this.start();
  }

  async status(): Promise<CoreState> {
    const child = this.child;
    if (!child?.pid || !isProcessAlive(child.pid)) {
      return { running: false };
    }

    const settings = this.getSettings();
    const api = new MihomoApi(settings.controller, settings.secret);
    let healthy = false;
    let version: string | undefined;
    try {
      version = await api.version();
      healthy = true;
    } catch {
      healthy = false;
    }

    return {
      running: true,
      pid: child.pid,
      startedAt: this.childStartedAt,
      healthy,
      version,
    };
  }

  isRunning(): boolean {
    return Boolean(this.child && isProcessAlive(this.child.pid ?? -1));
  }

  /**
   * Reconcile stale core processes on daemon startup: if a previous core
   * was orphaned, verify its executable identity before killing it.
   */
  async cleanStaleCore(): Promise<void> {
    const record = readPidRecord(this.layout.pidFile);
    if (!record) return;

    if (!isProcessAlive(record.pid)) {
      clearPidRecord(this.layout.pidFile);
      return;
    }

    const identity = classifyProcessIdentity(record.pid, record.exe);
    if (identity === "match") {
      await killProcessGracefully(record.pid, { timeoutMs: 5000 });
    }
    clearPidRecord(this.layout.pidFile);
  }
}

export interface DaemonDeps {
  layout: SashLayout;
  settings: SashSettings;
  supervisor?: CoreSupervisor;
  sysproxy?: SysproxyAdapter;
  token?: string;
  fetchSubscriptionFn?: (url: string) => Promise<Record<string, unknown>>;
  onShutdown?: () => void;
}

export interface DaemonInstance {
  server: Server;
  supervisor: CoreSupervisor;
  token: string;
  port: number;
  close: () => Promise<void>;
}

function parseJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error("Request body too large (exceeds 1MB)"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON: ${(err as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { error: message });
}

function parseHostPort(address: string): { host: string; port: number } {
  const trimmed = address.trim();
  const match = trimmed.match(/^(?:https?:\/\/)?(?:\[([0-9a-fA-F:]+)\]|([^:]+)):(\d+)$/);
  if (match) {
    const host = match[1] ?? match[2] ?? "127.0.0.1";
    const port = Number.parseInt(match[3] ?? "9090", 10);
    return { host, port };
  }
  return { host: "127.0.0.1", port: 9090 };
}

function resolveUiDir(layout: SashLayout): string | null {
  if (fs.existsSync(path.join(layout.uiDir, "index.html"))) {
    return layout.uiDir;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distUi = path.join(here, "ui");
  if (fs.existsSync(path.join(distUi, "index.html"))) {
    return distUi;
  }
  const devUi = path.join(path.dirname(here), "dist", "ui");
  if (fs.existsSync(path.join(devUi, "index.html"))) {
    return devUi;
  }
  return null;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function createDaemonServer(deps: DaemonDeps): DaemonInstance {
  const layout = deps.layout;
  const settings = { ...deps.settings };
  const token = deps.token ?? crypto.randomBytes(24).toString("hex");
  const startedAt = new Date().toISOString();
  const fetchSub = deps.fetchSubscriptionFn ?? fetchSubscription;

  const sysproxyAdapter: SysproxyAdapter = deps.sysproxy ?? {
    enable: (opts) => enableSystemProxy(opts),
    disable: () => disableSystemProxy(),
    getState: () => getSystemProxyState(),
  };

  let proxyApplied = false;

  const applyProxyIfDesired = async (): Promise<void> => {
    if (settings.systemProxy && supervisor.isRunning()) {
      try {
        await sysproxyAdapter.enable({ port: settings.mixedPort });
        proxyApplied = true;
      } catch {
        proxyApplied = false;
      }
    }
  };

  const removeProxyIfApplied = async (): Promise<void> => {
    if (proxyApplied) {
      try {
        await sysproxyAdapter.disable();
      } catch {
        // ignore
      }
      proxyApplied = false;
    }
  };

  const supervisor =
    deps.supervisor ??
    new CoreSupervisor({
      layout,
      settings: () => settings,
      onExit: async () => {
        await removeProxyIfApplied();
      },
    });

  const checkAuth = (req: IncomingMessage): boolean => {
    const auth = req.headers.authorization;
    if (!auth || !settings.daemonSecret) return false;
    const match = auth.match(/^Bearer\s+(\S+)$/i);
    return match?.[1] === settings.daemonSecret;
  };

  const forwardToCore = (req: IncomingMessage, res: ServerResponse, targetPath: string): void => {
    const { host, port } = parseHostPort(settings.controller);
    const upstreamHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
    delete upstreamHeaders.host;
    if (settings.secret) {
      upstreamHeaders.authorization = `Bearer ${settings.secret}`;
    }

    const proxyReq = http.request(
      {
        hostname: host,
        port,
        path: targetPath,
        method: req.method,
        headers: upstreamHeaders,
        timeout: 30_000,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        sendError(res, 502, `Core controller unavailable: ${(err as Error).message}`);
      }
    });

    req.pipe(proxyReq);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method?.toUpperCase() ?? "GET";

    // 1. Unauthenticated identity probe (/sash/health and /health alias)
    if (method === "GET" && (pathname === "/sash/health" || pathname === "/health")) {
      sendJson(res, 200, {
        ok: true,
        token,
        pid: process.pid,
        startedAt,
      });
      return;
    }

    // 2. Static UI serving (for / and /ui/*) - public dashboard assets
    if (
      method === "GET" &&
      (pathname === "/" || pathname === "/ui" || pathname.startsWith("/ui/"))
    ) {
      const uiRoot = resolveUiDir(layout);
      if (uiRoot) {
        let relative = pathname.startsWith("/ui/") ? pathname.slice("/ui/".length) : "";
        if (!relative || relative === "ui" || pathname === "/") relative = "index.html";
        const candidate = path.join(uiRoot, relative);
        const targetFile =
          fs.existsSync(candidate) && fs.statSync(candidate).isFile()
            ? candidate
            : path.join(uiRoot, "index.html");

        if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
          const ext = path.extname(targetFile);
          const mime = MIME_TYPES[ext] ?? "application/octet-stream";
          res.writeHead(200, { "Content-Type": mime });
          fs.createReadStream(targetFile).pipe(res);
          return;
        }
      }
    }

    // 3. Authentication check for all remaining API routes
    if (!checkAuth(req)) {
      sendError(res, 401, "Unauthorized: valid Bearer token required");
      return;
    }

    try {
      /* ==================================================================== */
      /* /core/api/* — Reverse Proxy to Mihomo external-controller             */
      /* ==================================================================== */
      if (pathname.startsWith("/core/api")) {
        const targetSubPath = (pathname.slice("/core/api".length) || "/") + url.search;
        forwardToCore(req, res, targetSubPath);
        return;
      }

      /* ==================================================================== */
      /* /sash/* — Sash Supervisor Domain                                     */
      /* ==================================================================== */
      if (method === "GET" && (pathname === "/sash/status" || pathname === "/status")) {
        const core = await supervisor.status();
        let actualProxy: SystemProxyState | undefined;
        try {
          actualProxy = sysproxyAdapter.getState();
        } catch {
          // ignore
        }
        const status: DaemonStatus = {
          daemon: {
            pid: process.pid,
            startedAt,
            port: settings.daemonPort,
          },
          core,
          systemProxy: {
            desired: settings.systemProxy,
            applied: proxyApplied,
            actual: actualProxy,
          },
          settings,
        };
        sendJson(res, 200, status);
        return;
      }

      if (method === "GET" && (pathname === "/sash/proxy" || pathname === "/proxy")) {
        const state = sysproxyAdapter.getState();
        sendJson(res, 200, {
          desired: settings.systemProxy,
          applied: proxyApplied,
          ...state,
        });
        return;
      }

      if (
        method === "POST" &&
        (pathname === "/sash/proxy/enable" || pathname === "/proxy/enable")
      ) {
        if (!supervisor.isRunning()) {
          sendError(res, 400, "Cannot enable system proxy: core is not running");
          return;
        }
        settings.systemProxy = true;
        saveSettings(settings, layout);
        await sysproxyAdapter.enable({ port: settings.mixedPort });
        proxyApplied = true;
        sendJson(res, 200, { ok: true, systemProxy: true });
        return;
      }

      if (
        method === "POST" &&
        (pathname === "/sash/proxy/disable" || pathname === "/proxy/disable")
      ) {
        settings.systemProxy = false;
        saveSettings(settings, layout);
        await sysproxyAdapter.disable();
        proxyApplied = false;
        sendJson(res, 200, { ok: true, systemProxy: false });
        return;
      }

      if (method === "GET" && pathname === "/sash/subscription") {
        sendJson(res, 200, { url: settings.subscriptionUrl });
        return;
      }

      if (
        method === "POST" &&
        (pathname === "/sash/subscription" || pathname === "/subscription")
      ) {
        const body = (await parseJsonBody(req)) as { url?: unknown };
        const urlStr = typeof body.url === "string" ? body.url.trim() : "";
        if (!urlStr) {
          sendError(res, 400, "Missing required 'url' string");
          return;
        }
        const doc = await fetchSub(urlStr);
        settings.subscriptionUrl = urlStr;
        saveSettings(settings, layout);
        const result = await generateConfig({ layout, settings, subscription: doc });
        if (supervisor.isRunning()) {
          const api = new MihomoApi(settings.controller, settings.secret);
          await api.reloadConfig(layout.configFile);
        }
        sendJson(res, 200, { ok: true, proxyCount: result.proxyCount });
        return;
      }

      if (
        method === "DELETE" &&
        (pathname === "/sash/subscription" || pathname === "/subscription")
      ) {
        settings.subscriptionUrl = "";
        saveSettings(settings, layout);
        await generateConfig({ layout, settings });
        if (supervisor.isRunning()) {
          const api = new MihomoApi(settings.controller, settings.secret);
          await api.reloadConfig(layout.configFile);
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (
        method === "POST" &&
        (pathname === "/sash/subscription/refresh" || pathname === "/subscription/refresh")
      ) {
        if (!settings.subscriptionUrl) {
          sendError(res, 400, "No subscription configured");
          return;
        }
        const doc = await fetchSub(settings.subscriptionUrl);
        const result = await generateConfig({ layout, settings, subscription: doc });
        if (supervisor.isRunning()) {
          const api = new MihomoApi(settings.controller, settings.secret);
          await api.reloadConfig(layout.configFile);
        }
        sendJson(res, 200, { ok: true, proxyCount: result.proxyCount });
        return;
      }

      if (method === "GET" && pathname === "/sash/settings") {
        sendJson(res, 200, { ok: true, settings });
        return;
      }

      if (method === "PATCH" && (pathname === "/sash/settings" || pathname === "/settings")) {
        const body = (await parseJsonBody(req)) as { key?: unknown; value?: unknown };
        const key = typeof body.key === "string" ? body.key : "";
        const value = typeof body.value === "string" ? body.value : undefined;
        if (!key) {
          sendError(res, 400, "Missing 'key' in request body");
          return;
        }

        applyManagedKey(settings, key, value);
        saveSettings(settings, layout);

        if (key === "system-proxy") {
          if (settings.systemProxy && supervisor.isRunning()) {
            await sysproxyAdapter.enable({ port: settings.mixedPort });
            proxyApplied = true;
          } else {
            await sysproxyAdapter.disable();
            proxyApplied = false;
          }
        } else {
          const doc = settings.subscriptionUrl
            ? await fetchSub(settings.subscriptionUrl)
            : undefined;
          await generateConfig({ layout, settings, subscription: doc });
          if (supervisor.isRunning()) {
            if (requiresCoreRestart(key)) {
              await supervisor.restart();
            } else {
              const api = new MihomoApi(settings.controller, settings.secret);
              await api.reloadConfig(layout.configFile);
            }
          }
        }

        sendJson(res, 200, { ok: true, settings });
        return;
      }

      if (method === "POST" && (pathname === "/sash/shutdown" || pathname === "/shutdown")) {
        sendJson(res, 200, { ok: true, shuttingDown: true });
        setImmediate(async () => {
          await removeProxyIfApplied();
          await supervisor.stop();
          server.close();
          deps.onShutdown?.();
        });
        return;
      }

      /* ==================================================================== */
      /* /core/* — Core Lifecycle Domain                                      */
      /* ==================================================================== */
      if (method === "POST" && pathname === "/core/start") {
        const result = await supervisor.start();
        await applyProxyIfDesired();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/core/stop") {
        await removeProxyIfApplied();
        await supervisor.stop();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/core/restart") {
        await removeProxyIfApplied();
        const result = await supervisor.restart();
        await applyProxyIfDesired();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (
        method === "POST" &&
        (pathname === "/core/config/reload" || pathname === "/config/reload")
      ) {
        const doc = settings.subscriptionUrl ? await fetchSub(settings.subscriptionUrl) : undefined;
        const result = await generateConfig({ layout, settings, subscription: doc });
        if (supervisor.isRunning()) {
          const api = new MihomoApi(settings.controller, settings.secret);
          await api.reloadConfig(layout.configFile);
        }
        sendJson(res, 200, { ok: true, proxyCount: result.proxyCount, source: result.source });
        return;
      }

      sendError(res, 404, `Not found: ${method} ${pathname}`);
    } catch (err) {
      sendError(res, 500, (err as Error).message);
    }
  });

  // Handle WebSocket upgrade proxying to Core controller (e.g. for /core/api/traffic)
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (!pathname.startsWith("/core/api")) {
      socket.destroy();
      return;
    }

    if (!checkAuth(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const { host, port } = parseHostPort(settings.controller);
    const targetSubPath = (pathname.slice("/core/api".length) || "/") + url.search;

    const upstreamHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
    delete upstreamHeaders.host;
    if (settings.secret) {
      upstreamHeaders.authorization = `Bearer ${settings.secret}`;
    }

    const proxyReq = http.request({
      hostname: host,
      port,
      path: targetSubPath,
      method: "GET",
      headers: upstreamHeaders,
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      const statusLine = `HTTP/1.1 ${proxyRes.statusCode ?? 101} ${proxyRes.statusMessage ?? "Switching Protocols"}\r\n`;
      const headerLines = Object.entries(proxyRes.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join("\r\n");
      socket.write(`${statusLine}${headerLines}\r\n\r\n`);

      if (proxyHead.length > 0) socket.write(proxyHead);
      if (head.length > 0) proxySocket.write(head);

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxyReq.on("error", () => {
      socket.destroy();
    });

    proxyReq.end();
  });

  return {
    server,
    supervisor,
    token,
    port: settings.daemonPort,
    close: async () => {
      await removeProxyIfApplied();
      await supervisor.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Production daemon entrypoint. Reconciles stale state, starts the HTTP
 * listener, writes the daemon PID record, and handles termination signals.
 */
export async function runDaemon(opts: { layout?: SashLayout } = {}): Promise<void> {
  const layout = opts.layout ?? sashLayout();
  const settings = loadSettings(layout);

  const instance = createDaemonServer({
    layout,
    settings,
    onShutdown: () => {
      clearPidRecord(layout.daemonPidFile);
      process.exit(0);
    },
  });

  // Reconcile leftover core process from previous runs
  await instance.supervisor.cleanStaleCore();

  // Self-heal proxy if leftover from crash
  try {
    const actual = getSystemProxyState();
    if (actual.enabled && !settings.systemProxy) {
      await disableSystemProxy();
    }
  } catch {
    // ignore
  }

  const port = settings.daemonPort;
  await new Promise<void>((resolve, reject) => {
    instance.server.listen(port, "127.0.0.1", () => resolve());
    instance.server.once("error", reject);
  });

  // Write daemon PID record
  const pidRecord: DaemonPidRecord = {
    pid: process.pid,
    token: instance.token,
    port,
    startedAt: new Date().toISOString(),
  };
  fs.mkdirSync(layout.stateDir, { recursive: true });
  fs.writeFileSync(layout.daemonPidFile, `${JSON.stringify(pidRecord, null, 2)}\n`, {
    mode: 0o600,
  });

  const onSignal = async () => {
    try {
      await instance.close();
      clearPidRecord(layout.daemonPidFile);
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}
