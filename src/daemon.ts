import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import http from "node:http";
import type { Duplex } from "node:stream";
import YAML from "yaml";
import { MihomoApi } from "./api.js";
import { forwardHttpToCore, forwardWsToCore } from "./daemon-proxy.js";
import { serveStaticUi } from "./daemon-static.js";
import {
  buildDefaultConfig,
  fetchSubscriptionProfile,
  generateConfig,
  isValidMihomoConfig,
  type SubscriptionFetch,
} from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { clearPidRecord } from "./process.js";
import {
  addProfile,
  applySubscriptionFetch,
  findProfileByUrl,
  getActiveProfile,
  loadProfiles,
  migrateLegacySubscription,
  type ProfileMeta,
  type ProfilesIndex,
  profileDueForUpdate,
  profileFilePath,
  profileNameFromUrl,
  readProfileDoc,
  recordProfileError,
  removeProfile,
  setActiveProfile,
} from "./profiles.js";
import {
  applyManagedKey,
  loadSettings,
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
  settings: SashSettings;
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

export function createDaemonServer(deps: DaemonDeps): DaemonInstance {
  const layout = deps.layout;
  const settings = { ...deps.settings };
  const token = deps.token ?? crypto.randomBytes(24).toString("hex");
  const startedAt = new Date().toISOString();
  const fetchProfile = deps.fetchProfileFn ?? fetchSubscriptionProfile;

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

  const syncSystemProxy = async (enable: boolean): Promise<void> => {
    settings.systemProxy = enable;
    saveSettings(settings, layout);
    if (enable) {
      await sysproxyAdapter.enable({ port: settings.mixedPort });
      proxyApplied = true;
    } else {
      await sysproxyAdapter.disable();
      proxyApplied = false;
    }
  };

  const compileAndReload = async (subscriptionDoc?: Record<string, unknown>) => {
    const result = await generateConfig({ layout, settings, subscription: subscriptionDoc });
    if (supervisor.isRunning()) {
      const api = new MihomoApi(settings.controller, settings.secret);
      await api.reloadConfig(layout.configFile);
    }
    return result;
  };

  /** Persist freshly fetched subscription content onto an existing profile. */
  const applyFetchedToProfile = (id: string, fetched: SubscriptionFetch): ProfilesIndex =>
    applySubscriptionFetch(id, fetched, layout);

  /**
   * Rebuild config.yaml from the active profile's stored document and
   * hot-reload the core. With no active profile the DIRECT-only default is
   * compiled. A profile whose file is missing (e.g. freshly migrated) is
   * fetched once as a bootstrap.
   */
  const recompileActiveAndReload = async () => {
    const index = loadProfiles(layout);
    const active = getActiveProfile(index);
    if (!active) return compileAndReload(buildDefaultConfig());
    let doc = readProfileDoc(layout, active.id);
    if (doc === undefined && active.url) {
      const fetched = await fetchProfile(active.url);
      applyFetchedToProfile(active.id, fetched);
      doc = fetched.doc;
    }
    return compileAndReload(doc);
  };

  /** Keep settings.subscriptionUrl mirroring the active profile (CLI/status compat). */
  const syncSubMirror = (index: ProfilesIndex): void => {
    const url = getActiveProfile(index)?.url ?? "";
    if (settings.subscriptionUrl !== url) {
      settings.subscriptionUrl = url;
      saveSettings(settings, layout);
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
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
    if (method === "GET" && url.pathname === "/ui") {
      res.writeHead(302, { Location: `/ui/${url.search}` });
      res.end();
      return;
    }

    // 4. Static WebUI assets
    if (method === "GET" && serveStaticUi(req, res, pathname, layout)) {
      return;
    }

    // 5. API routes
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
        const active = getActiveProfile(loadProfiles(layout));
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

      /* ==================================================================== */
      /* /sash/profiles* — Subscription profiles                                */
      /* ==================================================================== */
      if (method === "GET" && pathname === "/sash/profiles") {
        sendJson(res, 200, loadProfiles(layout));
        return;
      }

      if (method === "POST" && pathname === "/sash/profiles") {
        const body = (await parseJsonBody(req)) as {
          url?: unknown;
          name?: unknown;
          activate?: unknown;
        };
        const urlStr = typeof body.url === "string" ? body.url.trim() : "";
        if (!urlStr) {
          sendError(res, 400, "Missing required 'url' string");
          return;
        }
        const requestedName = typeof body.name === "string" ? body.name.trim() : "";
        const fetched = await fetchProfile(urlStr);

        // Re-downloading an already-tracked URL updates that profile in place.
        const existing = findProfileByUrl(loadProfiles(layout), urlStr);
        let index: ProfilesIndex;
        let profile: ProfileMeta;
        if (existing) {
          index = applyFetchedToProfile(existing.id, fetched);
          const found = index.profiles.find((p) => p.id === existing.id);
          if (!found) throw new Error(`profile not found after update: ${existing.id}`);
          profile = found;
        } else {
          const added = addProfile(
            {
              name: requestedName || fetched.name || profileNameFromUrl(urlStr),
              url: urlStr,
              yamlText: fetched.yamlText,
              ...(fetched.intervalHours ? { intervalHours: fetched.intervalHours } : {}),
              ...(fetched.subInfo ? { subInfo: fetched.subInfo } : {}),
              ...(fetched.homePage ? { homePage: fetched.homePage } : {}),
            },
            layout,
          );
          index = added.index;
          profile = added.profile;
        }

        // Explicit activate (CLI) wins; otherwise a first profile auto-activates.
        if ((body.activate === true || index.activeId === null) && index.activeId !== profile.id) {
          index = setActiveProfile(profile.id, layout);
        }
        syncSubMirror(index);
        const isActive = index.activeId === profile.id;
        const compiled = isActive ? await recompileActiveAndReload() : null;
        sendJson(res, 200, {
          ok: true,
          profile,
          activated: isActive,
          ...(compiled ? { proxyCount: compiled.proxyCount } : {}),
        });
        return;
      }

      if (method === "POST" && pathname === "/sash/profiles/import") {
        let body: { name?: unknown; content?: unknown };
        try {
          body = (await parseJsonBody(req, 8 * 1024 * 1024)) as typeof body;
        } catch (err) {
          sendError(res, 400, (err as Error).message);
          return;
        }
        const content = typeof body.content === "string" ? body.content : "";
        if (!content.trim()) {
          sendError(res, 400, "Missing required 'content' string");
          return;
        }
        let doc: unknown;
        try {
          doc = YAML.parse(content);
        } catch (err) {
          sendError(res, 400, `Content is not valid YAML: ${(err as Error).message}`);
          return;
        }
        if (!isValidMihomoConfig(doc)) {
          sendError(res, 400, "Content is not a Clash/mihomo config (missing proxies/rules)");
          return;
        }
        const name =
          typeof body.name === "string" && body.name.trim() ? body.name.trim() : "imported";
        // Imported files are plain local profiles: no URL, no scheduled updates.
        const added = addProfile({ name, url: "", yamlText: content, intervalHours: 0 }, layout);
        syncSubMirror(added.index);
        const isActive = added.index.activeId === added.profile.id;
        const compiled = isActive ? await recompileActiveAndReload() : null;
        sendJson(res, 200, {
          ok: true,
          profile: added.profile,
          activated: isActive,
          ...(compiled ? { proxyCount: compiled.proxyCount } : {}),
        });
        return;
      }

      if (method === "PUT" && pathname === "/sash/profiles/active") {
        const body = (await parseJsonBody(req)) as { id?: unknown };
        const id = body.id === null ? null : typeof body.id === "string" ? body.id : undefined;
        if (id === undefined) {
          sendError(res, 400, "Missing 'id' (profile id string, or null to deselect)");
          return;
        }
        let index: ProfilesIndex;
        try {
          index = setActiveProfile(id, layout);
        } catch (err) {
          sendError(res, 404, (err as Error).message);
          return;
        }
        syncSubMirror(index);
        const compiled = await recompileActiveAndReload();
        sendJson(res, 200, { ok: true, activeId: id, proxyCount: compiled.proxyCount });
        return;
      }

      if (method === "POST" && pathname === "/sash/profiles/update-all") {
        const index = loadProfiles(layout);
        const failed: Array<{ id: string; name: string; error: string }> = [];
        let updated = 0;
        let activeTouched = false;
        for (const p of index.profiles) {
          if (!p.url) continue;
          try {
            const fetched = await fetchProfile(p.url);
            applyFetchedToProfile(p.id, fetched);
            updated += 1;
            if (index.activeId === p.id) activeTouched = true;
          } catch (err) {
            recordProfileError(p.id, (err as Error).message, layout);
            failed.push({ id: p.id, name: p.name, error: (err as Error).message });
          }
        }
        const compiled = activeTouched ? await recompileActiveAndReload() : null;
        sendJson(res, 200, {
          ok: failed.length === 0,
          updated,
          failed,
          ...(compiled ? { proxyCount: compiled.proxyCount } : {}),
        });
        return;
      }

      const profileUpdateMatch = pathname.match(/^\/sash\/profiles\/([0-9]+)\/update$/);
      if (method === "POST" && profileUpdateMatch) {
        const id = profileUpdateMatch[1] as string;
        const index = loadProfiles(layout);
        const profile = index.profiles.find((p) => p.id === id);
        if (!profile) {
          sendError(res, 404, `profile not found: ${id}`);
          return;
        }
        if (!profile.url) {
          sendError(res, 400, "Local profile has no URL to update from");
          return;
        }
        const fetched = await fetchProfile(profile.url);
        const next = applyFetchedToProfile(id, fetched);
        const updatedProfile = next.profiles.find((p) => p.id === id);
        const compiled = index.activeId === id ? await recompileActiveAndReload() : null;
        sendJson(res, 200, {
          ok: true,
          profile: updatedProfile,
          ...(compiled ? { proxyCount: compiled.proxyCount } : {}),
        });
        return;
      }

      const profileDeleteMatch = pathname.match(/^\/sash\/profiles\/([0-9]+)$/);
      if (method === "DELETE" && profileDeleteMatch) {
        const id = profileDeleteMatch[1] as string;
        let wasActive: boolean;
        try {
          ({ wasActive } = removeProfile(id, layout));
        } catch (err) {
          sendError(res, 404, (err as Error).message);
          return;
        }
        syncSubMirror(loadProfiles(layout));
        const compiled = wasActive ? await recompileActiveAndReload() : null;
        sendJson(res, 200, {
          ok: true,
          wasActive,
          ...(compiled ? { proxyCount: compiled.proxyCount } : {}),
        });
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
          await generateConfig({ layout, settings });
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
        const result = await recompileActiveAndReload();
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
    const index = loadProfiles(layout);
    let activeTouched = false;
    for (const profile of index.profiles) {
      let fileExists = false;
      try {
        fileExists = fs.existsSync(profileFilePath(layout, profile.id));
      } catch {
        fileExists = false;
      }
      if (!profileDueForUpdate(profile, fileExists)) continue;
      try {
        const fetched = await fetchProfile(profile.url);
        applyFetchedToProfile(profile.id, fetched);
        if (index.activeId === profile.id) activeTouched = true;
      } catch (err) {
        recordProfileError(profile.id, (err as Error).message, layout);
      }
    }
    if (activeTouched) {
      try {
        await recompileActiveAndReload();
      } catch {
        // keep the currently running config on compile/reload failure
      }
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
  if (settings.subscriptionUrl) {
    migrateLegacySubscription(settings.subscriptionUrl, layout);
  }

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
