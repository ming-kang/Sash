import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { Duplex } from "node:stream";
import { errorMessage } from "../error-utils.js";
import { allowedControllerTarget } from "../launcher/controller-policy.js";
import { parseControllerAddress } from "../settings.js";
import { isControlMutation } from "./auth.js";
import type { DaemonContext } from "./context.js";
import { defaultCodeForStatus, errorToHttp, ShuttingDownError } from "./errors.js";
import { HttpError, type ParsedDaemonRequestTarget, sendError, sendSocketError } from "./http.js";

export type ControllerTarget = Pick<
  http.RequestOptions,
  "hostname" | "port" | "socketPath" | "createConnection"
> & {
  secret?: string;
};

export function directControllerTarget(address: string, secret: string): ControllerTarget {
  const parsed = parseControllerAddress(address);
  if (!parsed) {
    throw new Error(`Invalid controller address: ${address} (expected loopback host:port)`);
  }
  return { hostname: parsed.host, port: parsed.port, secret };
}

/** Hop-by-hop fields (RFC 9110, section 7.6.1). */
function endToEndHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const connection = headers.connection ?? "";
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...connection
      .toLowerCase()
      .split(",")
      .map((part) => part.trim()),
  ])
    delete result[name];
  return result;
}

export function coreApiTarget(target: ParsedDaemonRequestTarget): string {
  const prefix = "/core/api";
  const suffix = target.originalPathname.slice(prefix.length);
  const upstreamPath = suffix ? `/${suffix.replace(/^\/+/, "")}` : "/";
  return `${upstreamPath}${target.search}`;
}

function segmentsSurviveDecoding(pathname: string): boolean {
  return pathname.split("/").every((segment) => {
    try {
      return !decodeURIComponent(segment).includes("/");
    } catch {
      return false;
    }
  });
}

export function coreControllerTarget(ctx: DaemonContext): ControllerTarget | undefined {
  const runtime = ctx.settings.runtime();
  const connect = ctx.supervisor.controllerConnect();
  return connect
    ? { createConnection: connect }
    : runtime.tun.enable
      ? undefined
      : directControllerTarget(runtime.controller, runtime.secret);
}

export async function forwardToCore(
  ctx: DaemonContext,
  req: IncomingMessage,
  res: ServerResponse,
  target: ParsedDaemonRequestTarget,
): Promise<void> {
  const method = req.method?.toUpperCase() ?? "GET";
  const upstream = coreApiTarget(target);
  const privileged = ctx.settings.runtime().tun.enable || ctx.supervisor.isPrivileged();
  const pathname = upstream.split("?")[0] ?? "/";
  const allowedMutation =
    segmentsSurviveDecoding(pathname) &&
    ((method === "PUT" && /^\/proxies\/[^/]+$/.test(pathname)) ||
      (method === "DELETE" && /^\/connections(?:\/[^/]+)?$/.test(pathname)));
  if (!privileged && isControlMutation(method) && !allowedMutation) {
    sendError(res, 403, "conflict", "Use Sash controls to change managed Core configuration");
    return;
  }
  const forward = async () => {
    if (privileged && allowedControllerTarget(method, upstream)?.action === "restart") {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        if (Buffer.byteLength(chunk))
          throw new HttpError(400, "Controller restart does not accept a body");
      }
      await ctx.mutate(() => ctx.lifecycle.restartPrivileged());
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    const controller = coreControllerTarget(ctx);
    if (!controller) {
      sendError(res, 503, "internal", "Privileged Core controller unavailable");
      return;
    }
    await forwardHttpToCore(req, res, upstream, controller);
  };
  // The reply is already hijacked, so a proxy failure cannot fall back to the
  // Fastify error handler; report it on the raw response instead.
  try {
    if (isControlMutation(method)) await ctx.gate.runLiveMutation(forward);
    else await forward();
  } catch (error) {
    if (!res.destroyed && !res.headersSent) {
      const mapping =
        error instanceof ShuttingDownError || error instanceof HttpError
          ? errorToHttp(error)
          : {
              status: 502,
              code: "internal" as const,
              message: `Core controller unavailable: ${errorMessage(error)}`,
            };
      sendError(res, mapping.status, mapping.code, mapping.message);
    } else if (!res.destroyed) res.destroy();
  }
}

export function forwardHttpToCore(
  req: IncomingMessage,
  res: ServerResponse,
  targetPath: string,
  { secret, ...target }: ControllerTarget,
  validated?: { body: string },
): Promise<void> {
  const upstreamHeaders: IncomingHttpHeaders = validated
    ? {
        "content-length": String(Buffer.byteLength(validated.body)),
        ...(validated.body && { "content-type": "application/json" }),
      }
    : endToEndHeaders(req.headers);
  delete upstreamHeaders.host;
  delete upstreamHeaders.authorization;
  if (secret) {
    upstreamHeaders.authorization = `Bearer ${secret}`;
  }

  return new Promise<void>((resolve) => {
    let completed = false;

    const proxyReq = http.request(
      {
        ...target,
        path: targetPath,
        method: req.method,
        headers: upstreamHeaders,
        timeout: 30_000,
      },
      (proxyRes) => {
        if (res.destroyed) {
          proxyRes.destroy();
          return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, endToEndHeaders(proxyRes.headers));
        proxyRes.pipe(res);
        proxyRes.on("end", () => {
          completed = true;
        });
        proxyRes.on("error", () => {
          res.destroy();
        });
      },
    );
    proxyReq.once("close", resolve);

    proxyReq.on("timeout", () => {
      proxyReq.destroy(new Error("Core controller request timed out after 30000ms"));
    });

    proxyReq.on("error", (err) => {
      if (!res.headersSent && !res.destroyed) {
        sendError(res, 502, "internal", `Core controller unavailable: ${err.message}`);
      } else if (!res.destroyed) res.destroy();
    });

    res.on("close", () => {
      if (!completed) {
        proxyReq.destroy();
      }
    });

    if (validated) proxyReq.end(validated.body);
    else req.pipe(proxyReq);
  });
}

export function forwardWsToCore(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  targetPath: string,
  { secret, ...target }: ControllerTarget,
  filterHeaders = false,
): void {
  const upstreamHeaders: IncomingHttpHeaders = filterHeaders
    ? {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": req.headers["sec-websocket-key"],
        "sec-websocket-version": req.headers["sec-websocket-version"],
      }
    : { ...req.headers };
  delete upstreamHeaders.host;
  delete upstreamHeaders.authorization;
  if (secret) {
    upstreamHeaders.authorization = `Bearer ${secret}`;
  }

  const proxyReq = http.request({
    ...target,
    path: targetPath,
    method: "GET",
    headers: upstreamHeaders,
    timeout: 10_000,
  });

  let upstreamTransportSocket: Duplex | undefined;
  let upstreamSocket: Duplex | undefined;
  let cleaned = false;
  const cleanup = (closeDownstream: boolean): void => {
    if (cleaned) return;
    cleaned = true;
    proxyReq.destroy();
    upstreamTransportSocket?.destroy();
    upstreamSocket?.destroy();
    if (closeDownstream && !socket.destroyed) socket.destroy();
  };
  proxyReq.once("socket", (transportSocket) => {
    upstreamTransportSocket = transportSocket;
    if (cleaned) transportSocket.destroy();
  });

  socket.once("error", () => cleanup(true));
  socket.once("end", () => cleanup(true));
  socket.once("close", () => cleanup(false));

  const pendingClientChunks: Buffer[] = [];
  let pendingClientBytes = 0;
  const readPendingClientData = (): void => {
    while (true) {
      const chunk = socket.read() as Buffer | null;
      if (chunk === null) return;
      pendingClientBytes += chunk.length;
      if (pendingClientBytes > 64 * 1024) {
        cleanup(true);
        return;
      }
      pendingClientChunks.push(chunk);
    }
  };
  socket.on("readable", readPendingClientData);

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    readPendingClientData();
    socket.removeListener("readable", readPendingClientData);
    upstreamSocket = proxySocket;
    proxySocket.once("error", () => cleanup(true));
    proxySocket.once("close", () => cleanup(true));

    if (cleaned || socket.destroyed || !socket.writable) {
      proxySocket.destroy();
      return;
    }

    try {
      const statusLine = `HTTP/1.1 ${proxyRes.statusCode ?? 101} ${proxyRes.statusMessage ?? "Switching Protocols"}\r\n`;
      const headerLines = Object.entries(proxyRes.headers)
        .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
        .join("\r\n");
      socket.write(`${statusLine}${headerLines}\r\n\r\n`);

      if (proxyHead.length > 0) socket.write(proxyHead);
      if (head.length > 0) proxySocket.write(head);
      for (const chunk of pendingClientChunks) proxySocket.write(chunk);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    } catch {
      cleanup(true);
    }
  });

  proxyReq.on("response", (proxyRes) => {
    proxyRes.once("error", () => cleanup(true));
    if (cleaned || socket.destroyed || !socket.writable) {
      proxyRes.destroy();
      cleanup(false);
      return;
    }
    const status = proxyRes.statusCode ?? 502;
    sendSocketError(
      socket,
      status,
      defaultCodeForStatus(status),
      proxyRes.statusMessage ?? "Bad Gateway",
    );
    proxyRes.resume();
  });

  proxyReq.on("timeout", () => {
    proxyReq.destroy(new Error("Core WebSocket upgrade timed out after 10000ms"));
  });

  proxyReq.on("error", () => cleanup(true));

  if (socket.destroyed || !socket.writable) cleanup(false);
  else proxyReq.end();
}
