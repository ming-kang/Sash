import type { IncomingMessage, Server, ServerResponse } from "node:http";
import http from "node:http";
import type { Duplex } from "node:stream";
import {
  isLoopbackHostHeader,
  isLoopbackOriginHeader,
  isWebSocketRequestAuthorized,
} from "../daemon-auth.js";
import { forwardWsToCore } from "../daemon-proxy.js";
import type { RuntimeLifecycle } from "../runtime-lifecycle.js";
import type { CoreSupervisor } from "../supervisor.js";
import { buildDaemonContext, type DaemonApp, type DaemonDeps } from "./app.js";
import {
  buildRoutes,
  dispatch,
  matchWebSocketUpgrade,
  parseDaemonRequestTarget,
} from "./router.js";
import { startProfileUpdateScheduler } from "./scheduler.js";

export interface DaemonInstance {
  server: Server;
  supervisor: CoreSupervisor;
  lifecycle: RuntimeLifecycle;
  token: string;
  port: number;
  close: () => Promise<void>;
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
        daemonSecret: context.settings.committed().daemonSecret,
        bootToken: context.token,
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
    const route = matchWebSocketUpgrade(routes, req.method?.toUpperCase() ?? "GET", target);
    if (route.kind === "methodNotAllowed") {
      rejectUpgrade(socket, 405, "Method Not Allowed", route.allow);
      return;
    }
    if (route.kind === "notFound") {
      rejectUpgrade(socket, 404, "WebSocket endpoint not found");
      return;
    }
    if (context.gate.isClosing) {
      rejectUpgrade(socket, 503, "sashd is shutting down");
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
      if (!socket.destroyed) rejectUpgrade(socket, 500, "WebSocket proxy failed");
    }
  });

  const scheduler = startProfileUpdateScheduler(context.profiles, deps.scheduler ?? {});

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
      scheduler.stop();
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
    close: closeDaemon,
  };
}
