import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { Duplex } from "node:stream";
import { parseControllerAddress } from "../settings.js";
import {
  coreWebSocketProtocols,
  isControlMutation,
  webSocketAuthResponseProtocol,
} from "./auth.js";
import type { DaemonContext } from "./context.js";
import { defaultCodeForStatus } from "./errors.js";
import { type ParsedDaemonRequestTarget, sendError, sendSocketError } from "./http.js";

function parseHostPort(address: string): { host: string; port: number } {
  const parsed = parseControllerAddress(address);
  if (!parsed) {
    throw new Error(`Invalid controller address: ${address} (expected loopback host:port)`);
  }
  return { host: parsed.host, port: parsed.port };
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
  const suffix = target.pathname.slice(prefix.length);
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

export async function forwardToCore(
  ctx: DaemonContext,
  req: IncomingMessage,
  res: ServerResponse,
  target: ParsedDaemonRequestTarget,
): Promise<void> {
  const method = req.method?.toUpperCase() ?? "GET";
  const pathname = coreApiTarget(target).split("?")[0] ?? "/";
  const allowedMutation =
    segmentsSurviveDecoding(pathname) &&
    ((method === "PUT" && /^\/proxies\/[^/]+$/.test(pathname)) ||
      (method === "DELETE" && /^\/connections(?:\/[^/]+)?$/.test(pathname)));
  if (isControlMutation(method) && !allowedMutation) {
    sendError(res, 403, "conflict", "Use Sash controls to change managed Core configuration");
    return;
  }
  const runtime = ctx.settings.runtime();
  const forward = () =>
    forwardHttpToCore(req, res, coreApiTarget(target), runtime.controller, runtime.secret);
  if (isControlMutation(method)) await ctx.gate.runLiveMutation(forward);
  else await forward();
}

export function forwardHttpToCore(
  req: IncomingMessage,
  res: ServerResponse,
  targetPath: string,
  controller: string,
  secret: string,
): Promise<void> {
  const { host, port } = parseHostPort(controller);
  const upstreamHeaders = endToEndHeaders(req.headers);
  delete upstreamHeaders.host;
  delete upstreamHeaders.authorization;
  delete upstreamHeaders["x-sash-token"];
  if (secret) {
    upstreamHeaders.authorization = `Bearer ${secret}`;
  }

  return new Promise<void>((resolve) => {
    let completed = false;

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

    req.pipe(proxyReq);
  });
}

export function forwardWsToCore(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  targetPath: string,
  controller: string,
  secret: string,
): void {
  const { host, port } = parseHostPort(controller);
  const upstreamHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
  delete upstreamHeaders.host;
  delete upstreamHeaders.authorization;
  delete upstreamHeaders["x-sash-token"];
  const coreProtocols = coreWebSocketProtocols(upstreamHeaders["sec-websocket-protocol"]);
  if (coreProtocols) {
    upstreamHeaders["sec-websocket-protocol"] = coreProtocols;
  } else {
    delete upstreamHeaders["sec-websocket-protocol"];
  }
  if (secret) {
    upstreamHeaders.authorization = `Bearer ${secret}`;
  }

  const proxyReq = http.request({
    hostname: host,
    port,
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
      const responseHeaders = { ...proxyRes.headers };
      if (!responseHeaders["sec-websocket-protocol"]) {
        const authProtocol = webSocketAuthResponseProtocol(req.headers["sec-websocket-protocol"]);
        if (authProtocol) responseHeaders["sec-websocket-protocol"] = authProtocol;
      }
      const headerLines = Object.entries(responseHeaders)
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
