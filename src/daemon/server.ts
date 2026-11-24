import type { IncomingMessage, Server } from "node:http";
import http from "node:http";
import type { Duplex } from "node:stream";
import type { SashLayout } from "../paths.js";
import type { RuntimeLifecycle } from "../runtime-lifecycle.js";
import type { CoreSupervisor } from "../supervisor.js";
import { buildDaemonContext, type DaemonApp, type DaemonDeps } from "./app.js";
import { isControlRequestAuthorized } from "./auth.js";
import { buildDaemonApp } from "./fastify-app.js";
import { parseRequestTarget, sendError, sendSocketError } from "./http.js";
import { coreControllerTarget, forwardWsToCore } from "./proxy.js";
import { checkLoopbackBoundary, matchWebSocketUpgrade } from "./router.js";
import { buildRoutes } from "./routes.js";
import { type ProfileUpdateScheduler, startProfileUpdateScheduler } from "./scheduler.js";

const MAX_UPGRADED_SOCKETS = 64;

export interface DaemonInstance {
  server: Server;
  supervisor: CoreSupervisor;
  lifecycle: RuntimeLifecycle;
  bootId: string;
  port: number;
  version: string;
  startedAt: string;
  close: () => Promise<void>;
}

export async function createStartedDaemon(opts: {
  layout: SashLayout;
  packageRoot: string;
}): Promise<DaemonInstance> {
  const instance = createDaemonServer({ layout: opts.layout, packageRoot: opts.packageRoot });
  await instance.lifecycle.recoverStartup();
  return instance;
}

export function createDaemonServer(deps: DaemonDeps): DaemonInstance {
  const app: DaemonApp = buildDaemonContext(deps);
  const { context } = app;
  const routes = buildRoutes();
  const fastify = buildDaemonApp(context, routes);
  fastify.ready((err) => {
    if (err) console.error("[sashd] Fastify initialization failed:", err);
  });

  const server = http.createServer((req: IncomingMessage, res) => {
    const boundary = checkLoopbackBoundary(req);
    if (boundary) {
      sendError(res, boundary.status, boundary.code, boundary.message);
      return;
    }
    const parsed = parseRequestTarget(req);
    if (!parsed.ok) {
      sendError(res, 400, "http", parsed.message);
      return;
    }
    req.method = req.method?.toUpperCase() ?? "GET";
    req.daemonTarget = parsed.target;
    req.url = parsed.target.routePathname + parsed.target.search;
    fastify.routing(req, res);
  });

  const upgradedSockets = new Set<Duplex>();
  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const boundary = checkLoopbackBoundary(req);
    if (boundary) {
      sendSocketError(socket, boundary.status, boundary.code, boundary.message);
      return;
    }
    if (!isControlRequestAuthorized(req, context.settings.committed().daemonSecret)) {
      sendSocketError(socket, 401, "unauthorized", "Unauthorized WebSocket request");
      return;
    }

    const parsed = parseRequestTarget(req);
    if (!parsed.ok) {
      sendSocketError(socket, 400, "http", parsed.message);
      return;
    }
    const route = matchWebSocketUpgrade(routes, req.method?.toUpperCase() ?? "GET", parsed.target);
    if (route.kind === "methodNotAllowed") {
      sendSocketError(socket, 405, "http", "Method Not Allowed", route.allow);
      return;
    }
    if (route.kind === "notFound") {
      sendSocketError(socket, 404, "not_found", "WebSocket endpoint not found");
      return;
    }
    if (context.gate.isClosing) {
      sendSocketError(socket, 503, "shutting_down", "Sash is shutting down");
      return;
    }

    const controller = coreControllerTarget(context);
    if (!controller) {
      sendSocketError(socket, 503, "internal", "Privileged Core controller unavailable");
      return;
    }
    forwardWsToCore(req, socket, head, route.target, controller);
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (upgradedSockets.size >= MAX_UPGRADED_SOCKETS) {
      sendSocketError(
        socket,
        503,
        "shutting_down",
        "WebSocket streams are unavailable; reconnect shortly",
      );
      return;
    }
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    try {
      handleUpgrade(req, socket, head);
    } catch (err) {
      console.error("[sashd] unhandled WebSocket upgrade error:", err);
      if (!socket.destroyed) sendSocketError(socket, 500, "internal", "WebSocket proxy failed");
    }
  });

  let scheduler: ProfileUpdateScheduler | undefined;
  server.once("listening", () => {
    scheduler = startProfileUpdateScheduler(
      context.profiles,
      deps.scheduler ?? {},
      () => !context.gate.isClosing,
    );
  });

  let listenerClosePromise: Promise<void> | undefined;
  const closeListener = (): Promise<void> => {
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
      try {
        scheduler?.stop();
      } finally {
        context.events.close();
      }
    })();
    listenerClosePromise = attempt;
    void attempt.catch(() => {
      if (listenerClosePromise === attempt) {
        listenerClosePromise = undefined;
        context.gate.reopen();
      }
    });
    return attempt;
  };
  context.closeListener = closeListener;

  const closeDaemon = async (): Promise<void> => {
    await context.shutdown();
    await closeListener();
  };

  return {
    server,
    supervisor: app.supervisor,
    lifecycle: app.lifecycle,
    bootId: app.bootId,
    port: context.settings.committed().daemonPort,
    version: context.version,
    startedAt: context.startedAt,
    close: closeDaemon,
  };
}
