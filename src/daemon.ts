import crypto from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import http from "node:http";
import type { Duplex } from "node:stream";
import { MihomoApi } from "./api.js";
import {
  isControlMutation,
  isControlRequestAuthorized,
  isLoopbackHostHeader,
} from "./daemon-auth.js";
import { parseJsonBody, sendError, sendJson } from "./daemon-http.js";
import { handleProfileRoutes } from "./daemon-profile-routes.js";
import { forwardHttpToCore, forwardWsToCore } from "./daemon-proxy.js";
import { serveStaticUi } from "./daemon-static.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import type { SubscriptionFetch } from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { clearPidRecord } from "./process.js";
import { migrateLegacyProfileSetting } from "./profile-migration.js";
import { ProfileService } from "./profile-service.js";
import {
  applyManagedKey,
  loadSettings,
  type PublicSashSettings,
  publicSettings,
  requiresCoreRestart,
  type SashSettings,
  saveSettings,
} from "./settings.js";
import { type CoreState, CoreSupervisor, type SysproxyAdapter } from "./supervisor.js";
import {
  disableSystemProxy,
  enableSystemProxy,
  getSystemProxyState,
  type SystemProxyState,
} from "./sysproxy.js";

export { type CoreState, CoreSupervisor, type SysproxyAdapter };

export interface DaemonPidRecord {
  pid: number;
  token: string;
  port: number;
  startedAt: string;
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
  settings: PublicSashSettings;
  /** Active subscription profile, if any (profiles are the source of truth). */
  activeProfile: { id: string; name: string; url: string } | null;
}

export interface DaemonDeps {
  layout: SashLayout;
  settings: SashSettings;
  supervisor?: CoreSupervisor;
  sysproxy?: SysproxyAdapter;
  token?: string;
  fetchProfileFn?: (url: string) => Promise<SubscriptionFetch>;
  onShutdown?: () => void;
}

export interface DaemonInstance {
  server: Server;
  supervisor: CoreSupervisor;
  token: string;
  port: number;
  close: () => Promise<void>;
}

export function createDaemonServer(deps: DaemonDeps): DaemonInstance {
  const layout = deps.layout;
  const settings = { ...deps.settings };
  const token = deps.token ?? crypto.randomBytes(24).toString("hex");
  const startedAt = new Date().toISOString();
  const sysproxyAdapter: SysproxyAdapter = deps.sysproxy ?? {
    enable: (opts) => enableSystemProxy(opts),
    disable: () => disableSystemProxy(),
    getState: () => getSystemProxyState(),
  };

  let proxyApplied = false;

  const reconcileSystemProxy = async (forceDisable = false): Promise<void> => {
    const shouldApply = settings.systemProxy && supervisor.isRunning();
    if (shouldApply) {
      try {
        await sysproxyAdapter.enable({ port: settings.mixedPort });
        proxyApplied = true;
      } catch (err) {
        proxyApplied = false;
        throw err;
      }
      return;
    }
    if (proxyApplied || forceDisable) {
      await sysproxyAdapter.disable();
      proxyApplied = false;
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

  const syncSystemProxy = async (enable: boolean): Promise<void> => {
    settings.systemProxy = enable;
    saveSettings(settings, layout);
    await reconcileSystemProxy(!enable);
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

  const profiles = new ProfileService({
    layout,
    settings: () => settings,
    ...(deps.fetchProfileFn ? { fetchProfile: deps.fetchProfileFn } : {}),
    reloadConfig: async (configPath) => {
      if (!supervisor.isRunning()) return;
      const api = new MihomoApi(settings.controller, settings.secret);
      await api.reloadConfig(configPath);
    },
  });

  const server = http.createServer(async (req, res) => {
    if (!isLoopbackHostHeader(req.headers.host)) {
      sendError(res, 421, "Invalid Host header");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method?.toUpperCase() ?? "GET";

    // 1. Health probe
    if (method === "GET" && (pathname === "/sash/health" || pathname === "/health")) {
      sendJson(res, 200, { ok: true, token, pid: process.pid, startedAt });
      return;
    }

    // 2. Root redirect to /ui/
    if (pathname === "/") {
      res.writeHead(302, { Location: "/ui/" });
      res.end();
      return;
    }

    // 3. Redirect /ui to /ui/ so the dashboard's relative asset URLs resolve
    //    (must use the raw pathname: the normalized one maps /ui/ to /ui)
    if ((method === "GET" || method === "HEAD") && url.pathname === "/ui") {
      res.writeHead(302, { Location: `/ui/${url.search}` });
      res.end();
      return;
    }

    // 4. Static WebUI assets
    if ((method === "GET" || method === "HEAD") && serveStaticUi(req, res, pathname, layout)) {
      return;
    }

    // 5. State-changing control requests require a CLI bearer or WebUI boot token.
    if (
      isControlMutation(method) &&
      !isControlRequestAuthorized(req, { daemonSecret: settings.daemonSecret, bootToken: token })
    ) {
      sendError(res, 401, "Unauthorized control request");
      return;
    }

    // 6. API routes
    try {
      /* ==================================================================== */
      /* /core/api/* — Reverse Proxy to Mihomo external-controller             */
      /* ==================================================================== */
      if (pathname.startsWith("/core/api")) {
        const rawUrl = req.url ?? "/";
        const prefixIdx = rawUrl.indexOf("/core/api");
        const targetSubPath =
          prefixIdx >= 0 ? rawUrl.slice(prefixIdx + "/core/api".length) || "/" : "/";
        forwardHttpToCore(req, res, targetSubPath, settings.controller, settings.secret);
        return;
      }

      /* ==================================================================== */
      /* Fallback proxy for standard core endpoints                           */
      /* ==================================================================== */
      if (
        pathname === "/version" ||
        pathname.startsWith("/proxies") ||
        pathname.startsWith("/rules") ||
        pathname.startsWith("/connections") ||
        pathname.startsWith("/providers") ||
        pathname.startsWith("/dns")
      ) {
        forwardHttpToCore(req, res, pathname + url.search, settings.controller, settings.secret);
        return;
      }

      /* ==================================================================== */
      /* /sash/* — Supervisor Domain                                          */
      /* ==================================================================== */
      if (method === "GET" && (pathname === "/sash/status" || pathname === "/status")) {
        const core = await supervisor.status();
        let actualProxy: SystemProxyState | undefined;
        try {
          actualProxy = sysproxyAdapter.getState();
        } catch {
          // ignore
        }
        const active = profiles.active();
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
          settings: publicSettings(settings),
          activeProfile: active ? { id: active.id, name: active.name, url: active.url } : null,
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
        await syncSystemProxy(true);
        sendJson(res, 200, { ok: true, systemProxy: true });
        return;
      }

      if (
        method === "POST" &&
        (pathname === "/sash/proxy/disable" || pathname === "/proxy/disable")
      ) {
        await syncSystemProxy(false);
        sendJson(res, 200, { ok: true, systemProxy: false });
        return;
      }

      if (await handleProfileRoutes({ req, res, method, pathname, profiles })) {
        return;
      }

      if (method === "GET" && pathname === "/sash/settings") {
        sendJson(res, 200, { ok: true, settings: publicSettings(settings) });
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

        try {
          applyManagedKey(settings, key, value);
        } catch (err) {
          sendError(res, 400, (err as Error).message);
          return;
        }
        saveSettings(settings, layout);

        if (key === "system-proxy") {
          if (settings.systemProxy && supervisor.isRunning()) {
            await syncSystemProxy(true);
          } else {
            await syncSystemProxy(false);
          }
        } else {
          const restartRequired = supervisor.isRunning() && requiresCoreRestart(key);
          await profiles.reloadActive(!restartRequired);
          if (restartRequired) {
            await removeProxyIfApplied();
            try {
              await supervisor.restart();
              await reconcileSystemProxy();
            } catch (err) {
              await removeProxyIfApplied();
              throw err;
            }
          }
        }

        sendJson(res, 200, { ok: true, settings: publicSettings(settings) });
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
        await reconcileSystemProxy();
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
        await reconcileSystemProxy();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (
        method === "POST" &&
        (pathname === "/core/config/reload" || pathname === "/config/reload")
      ) {
        const result = await profiles.reloadActive();
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

    const isCoreWs =
      pathname.startsWith("/core/api") || pathname === "/traffic" || pathname === "/logs";
    if (!isCoreWs) {
      socket.destroy();
      return;
    }

    const rawUrl = req.url ?? "/";
    const prefixIdx = rawUrl.indexOf("/core/api");
    const targetSubPath =
      prefixIdx >= 0 ? rawUrl.slice(prefixIdx + "/core/api".length) || "/" : rawUrl;

    forwardWsToCore(req, socket, head, targetSubPath, settings.controller, settings.secret);
  });

  /* ====================================================================== */
  /* Scheduled profile auto-updates                                          */
  /* ====================================================================== */
  const PROFILE_UPDATE_CHECK_MS = 15 * 60 * 1000;

  const autoUpdateProfiles = async (): Promise<void> => {
    try {
      await profiles.updateDue();
    } catch {
      // Individual profile failures are recorded by ProfileService.
    }
  };

  const profileUpdateTimer = setInterval(() => {
    void autoUpdateProfiles();
  }, PROFILE_UPDATE_CHECK_MS);
  profileUpdateTimer.unref();
  const profileUpdateKickoff = setTimeout(() => {
    void autoUpdateProfiles();
  }, 10_000);
  profileUpdateKickoff.unref();

  return {
    server,
    supervisor,
    token,
    port: settings.daemonPort,
    close: async () => {
      clearInterval(profileUpdateTimer);
      clearTimeout(profileUpdateKickoff);
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

  // One-time migration: a legacy single subscription becomes an active,
  // meta-only profile whose content the auto-update scheduler then fetches.
  migrateLegacyProfileSetting(settings, layout);

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
  atomicWriteFileSync(layout.daemonPidFile, `${JSON.stringify(pidRecord, null, 2)}\n`);

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
