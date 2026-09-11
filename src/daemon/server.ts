import type { IncomingMessage, Server, ServerResponse } from "node:http";
import http from "node:http";
import type { Duplex } from "node:stream";
import type { RuntimeLifecycle } from "../runtime-lifecycle.js";
import type { CoreSupervisor } from "../supervisor.js";
import { buildDaemonContext, type DaemonApp, type DaemonDeps } from "./app.js";
import { isWebSocketRequestAuthorized } from "./auth.js";
import { sendSocketError } from "./http.js";
import { forwardWsToCore } from "./proxy.js";
import {
  buildRoutes,
  checkLoopbackBoundary,
  dispatch,
  matchWebSocketUpgrade,
  parseRequestTarget,
} from "./router.js";
import { type ProfileUpdateScheduler, startProfileUpdateScheduler } from "./scheduler.js";

export interface DaemonInstance {
  server: Server;
  supervisor: CoreSupervisor;
  lifecycle: RuntimeLifecycle;
  token: string;
  port: number;
  version: string;
  startedAt: string;
  close: () => Promise<void>;
}

export function createDaemonServer(deps: DaemonDeps): DaemonInstance {
  const app: DaemonApp = buildDaemonContext(deps);
  const { context } = app;
  const routes = buildRoutes();

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(context, routes, req, res).catch((err: unknown) => {
      console.error("[sashd] unhandled HTTP request error:", err);
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: "internal", message: "Internal server error" } }));
    });
  });

  // WebSocket streams reuse the HTTP route table: only gateway rows, GET only.
  const upgradedSockets = new Set<Duplex>();
  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const boundary = checkLoopbackBoundary(req);
    if (boundary) {
      sendSocketError(socket, boundary.status, boundary.code, boundary.message);
      return;
    }
    if (
      !isWebSocketRequestAuthorized(req, {
        daemonSecret: context.settings.committed().daemonSecret,
        isSessionToken: (token) => context.webAuth.isSession(token),
      })
    ) {
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
      sendSocketError(socket, 503, "shutting_down", "sashd is shutting down");
      return;
    }

    const runtime = context.settings.runtime();
    forwardWsToCore(req, socket, head, route.target, runtime.controller, runtime.secret);
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
      // Timers stay alive if either runtime cleanup or listener closure fails,
      // preserving retryability and scheduled updates after a failed close.
      scheduler?.stop();
      context.events.close();
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
    token: app.token,
    port: context.settings.committed().daemonPort,
    version: context.version,
    startedAt: context.startedAt,
    close: closeDaemon,
  };
}
