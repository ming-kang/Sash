import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import http from "node:http";
import type { Duplex } from "node:stream";
import { MihomoApi } from "./api.js";
import type { DaemonStatus } from "./contracts.js";
import { parseSettingsPatch, type SettingsPatch } from "./contracts.js";
import { assertCoreInstallationConsistent, currentCoreVersion } from "./core.js";
import { validateCoreConfigText } from "./core-config-validation.js";
import { recoverCoreInstallTransaction } from "./core-install-transaction.js";
import { pendingCoreUpdateVersion, readCoreUpdateTransaction } from "./core-update.js";
import {
  completeCoordinatedCoreUpdateAfterStart,
  rollbackCoordinatedCoreUpdate,
} from "./core-update-coordination.js";
import {
  isControlMutation,
  isControlRequestAuthorized,
  isLoopbackHostHeader,
  isLoopbackOriginHeader,
  isWebSocketRequestAuthorized,
} from "./daemon-auth.js";
import { HttpError, parseJsonObjectBody, sendError, sendJson } from "./daemon-http.js";
import { handleProfileRoutes } from "./daemon-profile-routes.js";
import { forwardHttpToCore, forwardWsToCore } from "./daemon-proxy.js";
import { matchHttpRoute, matchWebSocketRoute, parseDaemonRequestTarget } from "./daemon-routing.js";
import { serveStaticUi } from "./daemon-static.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import {
  readManagedStateTransactionStatus,
  recoverManagedStateTransaction,
} from "./managed-state-transaction.js";
import type { GeneratedConfig, SubscriptionFetch } from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { clearPidRecord } from "./process.js";
import { migrateProfileState } from "./profile-migration.js";
import {
  type PreparedActiveReload,
  ProfileConflictError,
  ProfileService,
} from "./profile-service.js";
import { RuntimeLifecycle } from "./runtime-lifecycle.js";
import { reconcileOrphanedRuntime } from "./runtime-recovery.js";
import {
  loadSettings,
  parseSettingsText,
  publicSettings,
  type SashSettings,
  saveSettings,
} from "./settings.js";
import { CoreUnhealthyError, SettingsInputError, SettingsService } from "./settings-service.js";
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

function sendMethodNotAllowed(res: ServerResponse, allow: readonly string[]): void {
  res.setHeader("Allow", allow.join(", "));
  sendError(res, 405, "Method Not Allowed");
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  message: string,
  allow?: readonly string[],
): void {
  const body = `${message}\n`;
  const allowHeader = allow ? `Allow: ${allow.join(", ")}\r\n` : "";
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n${allowHeader}Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
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
        completeCoordinatedCoreUpdateAfterStart(layout);
      },
      rollbackAfterStartFailure: () => rollbackCoordinatedCoreUpdate(layout),
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

  const commitPreparedReload = (
    prepared: PreparedActiveReload,
    reloadRuntime: boolean,
  ): Promise<GeneratedConfig> =>
    profiles.commitPreparedActiveReload(prepared, {
      reloadRuntime,
      boundary: "already-held",
    });

  const startCore = async () => {
    const retryAfterPreparation = Symbol("retry Core start after preparation");
    for (;;) {
      let prepared: PreparedActiveReload | undefined;
      if (!supervisor.isRunning()) {
        try {
          prepared = await profiles.prepareActiveReload();
        } catch (err) {
          // Preserve idempotent start semantics when another mutation brought
          // Core online while this request was preparing its stopped path.
          if (supervisor.isRunning()) continue;
          throw err;
        }
      }

      const preparedForStart = prepared;
      const result = await mutate("start core", async () => {
        if (!preparedForStart && !supervisor.isRunning()) return retryAfterPreparation;
        return lifecycle.start(
          preparedForStart
            ? async () => {
                await commitPreparedReload(preparedForStart, false);
              }
            : undefined,
        );
      });
      if (result !== retryAfterPreparation) return result;
    }
  };

  const withPreparedReloadRetry = async <T>(
    purpose: string,
    action: (prepared: PreparedActiveReload) => Promise<T>,
  ): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      const prepared = await profiles.prepareActiveReload();
      try {
        return await mutate(purpose, () => action(prepared));
      } catch (err) {
        if (!(err instanceof ProfileConflictError) || attempt >= 1) throw err;
      }
    }
  };

  const restartCore = (): Promise<Awaited<ReturnType<RuntimeLifecycle["restart"]>>> =>
    withPreparedReloadRetry("restart core", (prepared) =>
      lifecycle.restart(async () => {
        await commitPreparedReload(prepared, false);
      }),
    );

  const reloadCoreConfig = (): Promise<GeneratedConfig> =>
    withPreparedReloadRetry("reload core config", (prepared) =>
      commitPreparedReload(prepared, true),
    );

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackHostHeader(req.headers.host)) {
      sendError(res, 421, "Invalid Host header");
      return;
    }

    let target: ReturnType<typeof parseDaemonRequestTarget>;
    try {
      target = parseDaemonRequestTarget(req.url ?? "/", req.headers.host ?? "");
    } catch {
      sendError(res, 400, "Invalid request target");
      return;
    }
    const method = req.method?.toUpperCase() ?? "GET";
    const route = matchHttpRoute(method, target);

    // Public health and dashboard routes are resolved before control auth.
    if (route.kind === "health") {
      sendJson(res, 200, { ok: true, token, pid: process.pid, startedAt });
      return;
    }
    if (route.kind === "rootRedirect") {
      res.writeHead(302, { Location: `/ui/${target.search}` });
      res.end();
      return;
    }
    if (route.kind === "uiRedirect") {
      res.writeHead(302, { Location: `/ui/${target.search}` });
      res.end();
      return;
    }
    if (route.kind === "staticUi") {
      if (!serveStaticUi(req, res, target.routePathname, layout)) {
        sendError(res, 404, `Not found: ${method} ${target.routePathname}`);
      }
      return;
    }

    // Mutations and every matched Core gateway request require a CLI bearer or
    // WebUI boot token. The route match and upstream target share one parser.
    // The settings file read is also authenticated: it contains both secrets.
    if (isControlMutation(method) && !isLoopbackOriginHeader(req.headers.origin)) {
      sendError(res, 403, "Invalid Origin header");
      return;
    }
    if (
      (isControlMutation(method) ||
        route.kind === "coreGateway" ||
        route.kind === "settingsFileRead") &&
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

    // Route matching is pure; this switch owns only domain actions.
    try {
      switch (route.kind) {
        case "methodNotAllowed":
          sendMethodNotAllowed(res, route.allow);
          return;
        case "notFound":
          sendError(res, 404, `Not found: ${method} ${target.routePathname}`);
          return;
        case "coreGateway":
          forwardHttpToCore(
            req,
            res,
            route.target,
            runtimeSettings.controller,
            runtimeSettings.secret,
          );
          return;
        case "status": {
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
            const inspection = await systemProxy.inspect(target.searchParams.get("fresh") === "1");
            proxyApplied = inspection.applied;
            proxyAppliedKnown = inspection.appliedKnown;
            proxyStateKnown = inspection.stateKnown;
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
        case "proxyStatus": {
          const inspection = await systemProxy.inspect(target.searchParams.get("fresh") === "1");
          sendJson(res, 200, {
            desired: committedSettings.systemProxy,
            applied: inspection.applied,
            ...inspection.state,
            appliedKnown: inspection.appliedKnown,
            stateKnown: inspection.stateKnown,
            ...(inspection.queryError ? { queryError: inspection.queryError } : {}),
          });
          return;
        }
        case "proxyEnable": {
          try {
            await settingsService.apply({ systemProxy: true });
          } catch (err) {
            if (err instanceof CoreUnhealthyError) {
              sendError(res, 400, err.message);
              return;
            }
            throw err;
          }
          sendJson(res, 200, { ok: true, systemProxy: true });
          return;
        }
        case "proxyDisable":
          await settingsService.apply({ systemProxy: false });
          sendJson(res, 200, { ok: true, systemProxy: false });
          return;
        case "profiles": {
          const handled = await handleProfileRoutes({
            req,
            res,
            method,
            pathname: target.routePathname,
            profiles,
          });
          if (!handled) throw new Error("Matched profile route was not handled");
          return;
        }
        case "settingsRead":
          sendJson(res, 200, { ok: true, settings: publicSettings(committedSettings) });
          return;
        case "settingsFileRead": {
          let content: string;
          try {
            content = fs.readFileSync(layout.settingsFile, "utf8");
          } catch {
            sendError(res, 404, "Settings file does not exist yet");
            return;
          }
          sendJson(res, 200, { ok: true, content });
          return;
        }
        case "settingsFileWrite": {
          const body = await parseJsonObjectBody(req, 256 * 1024);
          const content = typeof body.content === "string" ? body.content : "";
          let parsed: SashSettings;
          try {
            parsed = parseSettingsText(content, layout.settingsFile);
          } catch (err) {
            sendError(res, 400, (err as Error).message);
            return;
          }
          try {
            const result = await settingsService.applyFileSettings(parsed);
            // daemonSecret is read from memory on every authenticated request,
            // so it hot-swaps. daemonPort only lands on disk: the listener
            // cannot be rebound online, and the next `sash restart` picks it up.
            sendJson(res, 200, {
              ok: true,
              restartRequired: result.restartRequired,
              settings: publicSettings(result.settings),
            });
          } catch (err) {
            if (err instanceof SettingsInputError) {
              sendError(res, 400, err.message);
              return;
            }
            if (err instanceof CoreUnhealthyError) {
              sendError(res, 409, err.message);
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
        case "settingsUpdate": {
          const body = await parseJsonObjectBody(req);
          let patch: SettingsPatch;
          try {
            patch = parseSettingsPatch(body);
          } catch (err) {
            sendError(res, 400, (err as Error).message);
            return;
          }

          try {
            const result = await settingsService.apply(patch);
            sendJson(res, 200, {
              ok: true,
              restartRequired: result.restartRequired,
              settings: publicSettings(result.settings),
            });
          } catch (err) {
            if (err instanceof SettingsInputError) {
              sendError(res, 400, err.message);
              return;
            }
            if (err instanceof CoreUnhealthyError) {
              sendError(res, 409, err.message);
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
        case "maintenanceShutdown":
        case "shutdown":
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
            if (route.kind === "maintenanceShutdown") {
              sendJson(res, 200, { ok: true, coreWasRunning: snapshot.coreWasRunning });
            } else {
              sendJson(res, 200, { ok: true, shuttingDown: true });
            }
          } catch (err) {
            sendError(res, 500, (err as Error).message);
          }
          return;
        case "coreStart": {
          const result = await startCore();
          sendJson(res, 200, { ok: true, ...result });
          return;
        }
        case "coreStop":
          await mutate("stop core", () => lifecycle.stop());
          sendJson(res, 200, { ok: true });
          return;
        case "coreRestart": {
          const result = await restartCore();
          sendJson(res, 200, { ok: true, ...result });
          return;
        }
        case "coreConfigReload": {
          const result = await reloadCoreConfig();
          sendJson(res, 200, {
            ok: true,
            proxyCount: result.proxyCount,
            source: result.source,
          });
          return;
        }
      }
    } catch (err) {
      if (err instanceof HttpError) sendError(res, err.statusCode, err.message);
      else if (err instanceof ProfileConflictError) sendError(res, 409, err.message);
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

  // Handle authenticated WebSocket streams through the same canonical target
  // parser used by HTTP Core gateway requests.
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

    let target: ReturnType<typeof parseDaemonRequestTarget>;
    try {
      target = parseDaemonRequestTarget(req.url ?? "/", req.headers.host ?? "");
    } catch {
      rejectUpgrade(socket, 400, "Invalid request target");
      return;
    }
    const route = matchWebSocketRoute(req.method?.toUpperCase() ?? "GET", target);
    if (route.kind === "methodNotAllowed") {
      rejectUpgrade(socket, 405, "Method Not Allowed", route.allow);
      return;
    }
    if (route.kind === "notFound") {
      rejectUpgrade(socket, 404, "WebSocket endpoint not found");
      return;
    }
    if (closing) {
      rejectUpgrade(socket, 503, "sashd is shutting down");
      return;
    }

    forwardWsToCore(
      req,
      socket,
      head,
      route.target,
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
      const managed = readManagedStateTransactionStatus(layout);
      if (managed?.coordination !== "core-update") {
        recoverManagedStateTransaction(layout);
      }

      let loaded = loadSettings(layout);
      // Restore proxy ownership and terminate only a verified stale Core before
      // touching an executable rollback slot. Coordinated managed snapshots may
      // remain published when the candidate still needs a managed start.
      const pendingUpdate = await reconcileOrphanedRuntime({ layout, settings: loaded });
      assertCoreInstallationConsistent(layout);
      loaded = loadSettings(layout);
      if (!pendingUpdate) {
        // Give the legacy URL priority. An unmanaged config.yaml is imported
        // only if the URL migration did not create an index.
        await migrateProfileState(loaded, layout);
      }
      return loaded;
    });

    const instance = createDaemonServer({ layout, settings });
    const serverClosed = new Promise<void>((resolve) => instance.server.once("close", resolve));

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
