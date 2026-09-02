import crypto from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import http from "node:http";
import type { Duplex } from "node:stream";
import { MihomoApi } from "./api.js";
import type { DaemonStatus } from "./contracts.js";
import { assertCoreInstallationConsistent, currentCoreVersion } from "./core.js";
import { validateCoreConfigText } from "./core-config-validation.js";
import { recoverCoreInstallTransaction } from "./core-install-transaction.js";
import {
  completePendingCoreUpdateAfterStart,
  pendingCoreUpdateVersion,
  readCoreUpdateTransaction,
  recoverCoreUpdateTransaction,
  rollbackCoreUpdateTransaction,
} from "./core-update.js";
import {
  isControlMutation,
  isControlRequestAuthorized,
  isCoreGatewayPath,
  isLoopbackHostHeader,
  isLoopbackOriginHeader,
  isWebSocketRequestAuthorized,
} from "./daemon-auth.js";
import { HttpError, parseJsonObjectBody, sendError, sendJson } from "./daemon-http.js";
import { handleProfileRoutes } from "./daemon-profile-routes.js";
import { forwardHttpToCore, forwardWsToCore } from "./daemon-proxy.js";
import { serveStaticUi } from "./daemon-static.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { recoverManagedStateTransaction } from "./managed-state-transaction.js";
import type { GeneratedConfig, SubscriptionFetch } from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { clearPidRecord } from "./process.js";
import { migrateProfileState } from "./profile-migration.js";
import { ProfileConflictError, ProfileService } from "./profile-service.js";
import { RuntimeLifecycle } from "./runtime-lifecycle.js";
import { loadSettings, publicSettings, type SashSettings, saveSettings } from "./settings.js";
import { SettingsInputError, SettingsService } from "./settings-service.js";
import { acquireStateLock, StateMutationQueue } from "./state-lock.js";
import { type CoreState, CoreSupervisor } from "./supervisor.js";
import type { SystemProxyState } from "./sysproxy.js";
import { type SystemProxyController, SystemProxyManager } from "./system-proxy-manager.js";

export type { DaemonStatus } from "./contracts.js";
export { type CoreState, CoreSupervisor };

export interface DaemonPidRecord {
  pid: number;
  token: string;
  port: number;
  startedAt: string;
}

export interface DaemonScheduler {
  intervalMs?: number;
  kickoffMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface DaemonDeps {
  layout: SashLayout;
  settings: SashSettings;
  supervisor?: CoreSupervisor;
  systemProxy?: SystemProxyController;
  token?: string;
  fetchProfileFn?: (url: string) => Promise<SubscriptionFetch>;
  validateConfigFn?: (generated: GeneratedConfig) => Promise<void> | void;
  onShutdown?: () => void;
  scheduler?: DaemonScheduler;
}

export interface DaemonInstance {
  server: Server;
  supervisor: CoreSupervisor;
  lifecycle: RuntimeLifecycle;
  token: string;
  port: number;
  close: () => Promise<void>;
}

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

export function createDaemonServer(deps: DaemonDeps): DaemonInstance {
  const layout = deps.layout;
  let committedSettings = saveSettings({ ...deps.settings }, layout);
  let runtimeSettings = committedSettings;
  const token = deps.token ?? crypto.randomBytes(24).toString("hex");
  const startedAt = new Date().toISOString();
  const systemProxy = deps.systemProxy ?? new SystemProxyManager({ layout });
  const mutations = new StateMutationQueue(layout.mutationLockFile);
  let profileRevision = 0;

  let lifecycle: RuntimeLifecycle | undefined;
  const supervisor =
    deps.supervisor ??
    new CoreSupervisor({
      layout,
      settings: () => runtimeSettings,
      expectedVersion: () =>
        pendingCoreUpdateVersion(layout) || currentCoreVersion(layout) || undefined,
      onExit: async () => {
        try {
          await lifecycle?.handleUnexpectedCoreExit();
        } catch (err) {
          console.error(
            `[sashd] failed to restore system proxy after Core exit: ${(err as Error).message}`,
          );
        }
      },
    });
  lifecycle = new RuntimeLifecycle({
    supervisor,
    systemProxy,
    settings: () => runtimeSettings,
    coreUpdate: {
      pending: () => readCoreUpdateTransaction(layout) !== undefined,
      completeAfterStart: () => {
        completePendingCoreUpdateAfterStart(layout);
      },
      rollbackAfterStartFailure: () => rollbackCoreUpdateTransaction(layout),
    },
  });

  let closing = false;
  let cleanupDaemon: () => Promise<{ coreWasRunning: boolean }>;
  let closeListener: () => Promise<void>;
  const mutate = <T>(purpose: string, action: () => T | Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error("sashd is shutting down"));
    return mutations.run(purpose, () => {
      if (closing) throw new Error("sashd is shutting down");
      return action();
    });
  };

  const profiles = new ProfileService({
    layout,
    settings: () => committedSettings,
    ...(deps.fetchProfileFn ? { fetchProfile: deps.fetchProfileFn } : {}),
    validateConfig:
      deps.validateConfigFn ?? ((generated) => validateCoreConfigText(generated.yaml, layout)),
    reloadConfig: async (configPath) => {
      if (!supervisor.isRunning()) return;
      const api = new MihomoApi(runtimeSettings.controller, runtimeSettings.secret);
      await api.reloadConfig(configPath);
    },
    commit: mutate,
    onChange: () => {
      profileRevision += 1;
    },
  });

  const settingsService = new SettingsService({
    layout,
    getCommitted: () => committedSettings,
    setCommitted: (next) => {
      committedSettings = { ...next };
    },
    setRuntime: (next) => {
      runtimeSettings = { ...next };
    },
    profiles,
    supervisor,
    lifecycle,
    commit: mutate,
  });

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackHostHeader(req.headers.host)) {
      sendError(res, 421, "Invalid Host header");
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    } catch {
      sendError(res, 400, "Invalid request target");
      return;
    }
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

    // 5. Mutations and every Core gateway request require a CLI bearer or
    //    WebUI boot token. HTTP mutations with a browser Origin must also be
    //    same-host loopback requests.
    if (isControlMutation(method) && !isLoopbackOriginHeader(req.headers.origin)) {
      sendError(res, 403, "Invalid Origin header");
      return;
    }
    if (
      (isControlMutation(method) || isCoreGatewayPath(pathname)) &&
      !isControlRequestAuthorized(req, {
        daemonSecret: committedSettings.daemonSecret,
        bootToken: token,
      })
    ) {
      sendError(res, 401, "Unauthorized control request");
      return;
    }

    if (closing && isControlMutation(method)) {
      sendError(res, 503, "sashd is shutting down");
      return;
    }

    // 6. API routes
    try {
      /* ==================================================================== */
      /* /core/api/* — Reverse Proxy to Mihomo external-controller             */
      /* ==================================================================== */
      if (matchesPathPrefix(pathname, "/core/api")) {
        const rawUrl = req.url ?? "/";
        const prefixIdx = rawUrl.indexOf("/core/api");
        const targetSubPath =
          prefixIdx >= 0 ? rawUrl.slice(prefixIdx + "/core/api".length) || "/" : "/";
        forwardHttpToCore(
          req,
          res,
          targetSubPath,
          runtimeSettings.controller,
          runtimeSettings.secret,
        );
        return;
      }

      /* ==================================================================== */
      /* Fallback proxy for standard core endpoints                           */
      /* ==================================================================== */
      if (isCoreGatewayPath(pathname)) {
        forwardHttpToCore(
          req,
          res,
          pathname + url.search,
          runtimeSettings.controller,
          runtimeSettings.secret,
        );
        return;
      }

      /* ==================================================================== */
      /* /sash/* — Supervisor Domain                                          */
      /* ==================================================================== */
      if (method === "GET" && (pathname === "/sash/status" || pathname === "/status")) {
        const runtimeCore = await supervisor.status();
        const installedVersion = currentCoreVersion(layout);
        const core =
          runtimeCore.version || !installedVersion
            ? runtimeCore
            : { ...runtimeCore, version: installedVersion };
        let actualProxy: SystemProxyState | undefined;
        let proxyApplied = false;
        let proxyAppliedKnown = false;
        let proxyStateKnown = false;
        let proxyQueryError: string | undefined;
        try {
          const inspection = systemProxy.inspect(url.searchParams.get("fresh") === "1");
          proxyApplied = inspection.applied;
          proxyAppliedKnown = inspection.appliedKnown !== false;
          proxyStateKnown = inspection.stateKnown !== false;
          if (proxyStateKnown) actualProxy = inspection.state;
          proxyQueryError = inspection.queryError;
        } catch (err) {
          proxyQueryError = err instanceof Error ? err.message : String(err);
        }
        const active = profiles.active();
        const status: DaemonStatus = {
          daemon: {
            pid: process.pid,
            startedAt,
            port: committedSettings.daemonPort,
          },
          revisions: {
            profiles: profileRevision,
          },
          core,
          systemProxy: {
            desired: committedSettings.systemProxy,
            applied: proxyApplied,
            actual: actualProxy,
            appliedKnown: proxyAppliedKnown,
            stateKnown: proxyStateKnown,
            ...(proxyQueryError ? { queryError: proxyQueryError } : {}),
          },
          settings: publicSettings(committedSettings),
          activeProfile: active ? { id: active.id, name: active.name, url: active.url } : null,
        };
        sendJson(res, 200, status);
        return;
      }

      if (method === "GET" && (pathname === "/sash/proxy" || pathname === "/proxy")) {
        const inspection = systemProxy.inspect(url.searchParams.get("fresh") === "1");
        sendJson(res, 200, {
          desired: committedSettings.systemProxy,
          applied: inspection.applied,
          ...inspection.state,
          appliedKnown: inspection.appliedKnown !== false,
          stateKnown: inspection.stateKnown !== false,
          ...(inspection.queryError ? { queryError: inspection.queryError } : {}),
        });
        return;
      }

      if (
        method === "POST" &&
        (pathname === "/sash/proxy/enable" || pathname === "/proxy/enable")
      ) {
        const core = await supervisor.status();
        if (!core.running || !core.healthy) {
          sendError(res, 400, "Cannot enable system proxy: core is not healthy");
          return;
        }
        await settingsService.update("system-proxy", "on");
        sendJson(res, 200, { ok: true, systemProxy: true });
        return;
      }

      if (
        method === "POST" &&
        (pathname === "/sash/proxy/disable" || pathname === "/proxy/disable")
      ) {
        await settingsService.update("system-proxy", "off");
        sendJson(res, 200, { ok: true, systemProxy: false });
        return;
      }

      const handledProfile = await handleProfileRoutes({ req, res, method, pathname, profiles });
      if (handledProfile) return;

      if (method === "GET" && pathname === "/sash/settings") {
        sendJson(res, 200, { ok: true, settings: publicSettings(committedSettings) });
        return;
      }

      if (method === "PATCH" && (pathname === "/sash/settings" || pathname === "/settings")) {
        const body = await parseJsonObjectBody(req);
        const key = typeof body.key === "string" ? body.key : "";
        const value = typeof body.value === "string" ? body.value : undefined;
        if (!key) {
          sendError(res, 400, "Missing 'key' in request body");
          return;
        }

        try {
          const updated = await settingsService.update(key, value);
          sendJson(res, 200, { ok: true, settings: publicSettings(updated) });
        } catch (err) {
          if (err instanceof SettingsInputError) {
            sendError(res, 400, err.message);
            return;
          }
          if (err instanceof ProfileConflictError) {
            sendError(res, 409, err.message);
            return;
          }
          throw err;
        }
        return;
      }

      if (
        method === "POST" &&
        (pathname === "/sash/maintenance/shutdown" ||
          pathname === "/sash/shutdown" ||
          pathname === "/shutdown")
      ) {
        try {
          // Cleanup must complete before acknowledging shutdown. Do not close
          // the listener here: server.close() waits for this response socket.
          const snapshot = await cleanupDaemon();
          let closingListener = false;
          const finishShutdown = (): void => {
            if (closingListener) return;
            closingListener = true;
            void closeListener()
              .then(() => deps.onShutdown?.())
              .catch(() => undefined);
          };
          res.once("finish", finishShutdown);
          res.once("close", finishShutdown);
          if (pathname === "/sash/maintenance/shutdown") {
            sendJson(res, 200, { ok: true, coreWasRunning: snapshot.coreWasRunning });
          } else {
            sendJson(res, 200, { ok: true, shuttingDown: true });
          }
        } catch (err) {
          sendError(res, 500, (err as Error).message);
        }
        return;
      }

      /* ==================================================================== */
      /* /core/* — Core Lifecycle Domain                                      */
      /* ==================================================================== */
      if (method === "POST" && pathname === "/core/start") {
        const result = await mutate("start core", () =>
          lifecycle.start(async () => {
            await profiles.reloadActive(false, false);
          }),
        );
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && pathname === "/core/stop") {
        await mutate("stop core", () => lifecycle.stop());
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/core/restart") {
        const result = await mutate("restart core", () =>
          lifecycle.restart(async () => {
            await profiles.reloadActive(false, false);
          }),
        );
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (
        method === "POST" &&
        (pathname === "/core/config/reload" || pathname === "/config/reload")
      ) {
        const result = await mutate("reload core config", () => profiles.reloadActive(true, false));
        sendJson(res, 200, { ok: true, proxyCount: result.proxyCount, source: result.source });
        return;
      }

      sendError(res, 404, `Not found: ${method} ${pathname}`);
    } catch (err) {
      if (err instanceof HttpError) sendError(res, err.statusCode, err.message);
      else sendError(res, 500, (err as Error).message);
    }
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      if (!(err instanceof HttpError)) {
        console.error("[sashd] unhandled HTTP request error:", err);
      }
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) sendError(res, err.statusCode, err.message);
      else sendError(res, 500, "Internal server error");
    });
  });

  // Handle WebSocket upgrade proxying to Core controller (e.g. for /core/api/traffic)
  const upgradedSockets = new Set<Duplex>();
  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!isLoopbackHostHeader(req.headers.host)) {
      rejectUpgrade(socket, 421, "Invalid Host header");
      return;
    }
    if (!isLoopbackOriginHeader(req.headers.origin)) {
      rejectUpgrade(socket, 403, "Invalid Origin header");
      return;
    }
    if (
      !isWebSocketRequestAuthorized(req, {
        daemonSecret: committedSettings.daemonSecret,
        bootToken: token,
      })
    ) {
      rejectUpgrade(socket, 401, "Unauthorized WebSocket request");
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    } catch {
      rejectUpgrade(socket, 400, "Invalid request target");
      return;
    }
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const isCoreWs =
      matchesPathPrefix(pathname, "/core/api") || pathname === "/traffic" || pathname === "/logs";
    if (!isCoreWs) {
      rejectUpgrade(socket, 404, "WebSocket endpoint not found");
      return;
    }

    const rawUrl = req.url ?? "/";
    const prefixIdx = rawUrl.indexOf("/core/api");
    const targetSubPath =
      prefixIdx >= 0 ? rawUrl.slice(prefixIdx + "/core/api".length) || "/" : rawUrl;

    forwardWsToCore(
      req,
      socket,
      head,
      targetSubPath,
      runtimeSettings.controller,
      runtimeSettings.secret,
    );
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    try {
      handleUpgrade(req, socket, head);
    } catch (err) {
      console.error("[sashd] unhandled WebSocket upgrade error:", err);
      if (!socket.destroyed) rejectUpgrade(socket, 500, "WebSocket proxy failed");
    }
  });

  /* ====================================================================== */
  /* Scheduled profile auto-updates                                          */
  /* ====================================================================== */
  const scheduler = deps.scheduler ?? {};
  const profileUpdateCheckMs = scheduler.intervalMs ?? 15 * 60 * 1000;
  const profileUpdateKickoffMs = scheduler.kickoffMs ?? 10_000;
  const scheduleInterval = scheduler.setInterval ?? setInterval;
  const clearScheduledInterval = scheduler.clearInterval ?? clearInterval;
  const scheduleTimeout = scheduler.setTimeout ?? setTimeout;
  const clearScheduledTimeout = scheduler.clearTimeout ?? clearTimeout;

  const autoUpdateProfiles = async (): Promise<void> => {
    try {
      await profiles.updateDue();
    } catch {
      // Individual profile failures are recorded by ProfileService.
    }
  };

  const profileUpdateTimer = scheduleInterval(() => {
    void autoUpdateProfiles();
  }, profileUpdateCheckMs);
  profileUpdateTimer.unref();
  const profileUpdateKickoff = scheduleTimeout(() => {
    void autoUpdateProfiles();
  }, profileUpdateKickoffMs);
  profileUpdateKickoff.unref();

  let schedulerStopped = false;
  const stopScheduler = (): void => {
    if (schedulerStopped) return;
    clearScheduledInterval(profileUpdateTimer);
    clearScheduledTimeout(profileUpdateKickoff);
    schedulerStopped = true;
  };

  let cleanupPromise: Promise<{ coreWasRunning: boolean }> | undefined;
  cleanupDaemon = () => {
    if (cleanupPromise) return cleanupPromise;
    // Close the admission gate before queueing the snapshot. Mutations already
    // queued finish first; later requests cannot enter after the snapshot.
    closing = true;
    const attempt = mutations.run("close daemon", async () => {
      const coreWasRunning = supervisor.isRunning();
      await lifecycle.close();
      return { coreWasRunning };
    });
    cleanupPromise = attempt;
    void attempt.catch(() => {
      if (cleanupPromise === attempt) {
        cleanupPromise = undefined;
        closing = false;
      }
    });
    return attempt;
  };

  let listenerClosePromise: Promise<void> | undefined;
  closeListener = () => {
    if (listenerClosePromise) return listenerClosePromise;
    const attempt = (async () => {
      if (server.listening) {
        const closed = new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
        server.closeAllConnections();
        for (const socket of upgradedSockets) socket.destroy();
        await closed;
      }
      // Timers stay alive if either runtime cleanup or listener closure fails,
      // preserving retryability and scheduled updates after a failed close.
      stopScheduler();
    })();
    listenerClosePromise = attempt;
    void attempt.catch(() => {
      if (listenerClosePromise === attempt) {
        listenerClosePromise = undefined;
        closing = false;
      }
    });
    return attempt;
  };

  const closeDaemon = async () => {
    await cleanupDaemon();
    await closeListener();
  };

  return {
    server,
    supervisor,
    lifecycle,
    token,
    port: committedSettings.daemonPort,
    close: closeDaemon,
  };
}

/**
 * Production daemon entrypoint. Reconciles stale state, starts the HTTP
 * listener, writes the daemon PID record, and handles termination signals.
 */
export async function runDaemon(opts: { layout?: SashLayout } = {}): Promise<void> {
  const layout = opts.layout ?? sashLayout();
  const daemonLease = await acquireStateLock(layout.daemonLeaseFile, {
    purpose: "sashd singleton",
    timeoutMs: 0,
  });
  let onSignal: (() => void) | undefined;

  try {
    const initialization = new StateMutationQueue(layout.mutationLockFile);
    const settings = await initialization.run("initialize daemon state", async () => {
      recoverCoreInstallTransaction(layout);
      recoverManagedStateTransaction(layout);
      const loaded = loadSettings(layout);
      // Recover first, then give the legacy URL priority. An unmanaged
      // config.yaml is imported only if the URL migration did not create an index.
      await migrateProfileState(loaded, layout);
      return loaded;
    });

    const instance = createDaemonServer({ layout, settings });
    const serverClosed = new Promise<void>((resolve) => instance.server.once("close", resolve));

    // Restore only proxy state proven to be owned by an earlier Sash session.
    // If that cannot be done safely, preserve the stale Core rather than
    // deliberately leaving an OS proxy pointed at a dead port.
    await instance.lifecycle.recoverStartup();
    await instance.supervisor.cleanStaleCore();
    recoverCoreUpdateTransaction(layout);
    assertCoreInstallationConsistent(layout);

    const port = settings.daemonPort;
    await new Promise<void>((resolve, reject) => {
      instance.server.listen(port, "127.0.0.1", () => resolve());
      instance.server.once("error", reject);
    });

    const pidRecord: DaemonPidRecord = {
      pid: process.pid,
      token: instance.token,
      port,
      startedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(layout.daemonPidFile, `${JSON.stringify(pidRecord, null, 2)}\n`);

    onSignal = () => {
      void instance.close().catch((err) => {
        console.error(`[sashd] shutdown blocked: ${(err as Error).message}`);
      });
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);

    await serverClosed;
  } finally {
    if (onSignal) {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
    }
    clearPidRecord(layout.daemonPidFile);
    daemonLease.release();
  }
}
