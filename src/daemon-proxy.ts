import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { Duplex } from "node:stream";
import { coreWebSocketProtocols } from "./daemon-auth.js";

export function parseHostPort(address: string): { host: string; port: number } {
  const trimmed = address.trim();
  const match = trimmed.match(/^(?:https?:\/\/)?(?:\[([0-9a-fA-F:]+)\]|([^:]*)):(\d+)$/);
  if (match) {
    const rawHost = match[1] ?? match[2];
    const host = rawHost && rawHost.length > 0 ? rawHost : "127.0.0.1";
    const port = Number.parseInt(match[3] ?? "9090", 10);
    return { host, port };
  }
  return { host: "127.0.0.1", port: 9090 };
}

/**
 * Forward HTTP requests to the Mihomo external controller, automatically
 * injecting the controller secret Authorization Bearer header.
 */
export function forwardHttpToCore(
  req: IncomingMessage,
  res: ServerResponse,
  targetPath: string,
  controller: string,
  secret: string,
): void {
  const { host, port } = parseHostPort(controller);
  const upstreamHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
  delete upstreamHeaders.host;
  delete upstreamHeaders.authorization;
  delete upstreamHeaders["x-sash-token"];
  if (secret) {
    upstreamHeaders.authorization = `Bearer ${secret}`;
  }

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
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
      proxyRes.on("end", () => {
        completed = true;
      });
      proxyRes.on("error", () => {
        res.destroy();
      });
    },
  );

  proxyReq.on("timeout", () => {
    proxyReq.destroy(new Error("Core controller request timed out after 30000ms"));
  });

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      const msg = JSON.stringify({
        error: `Core controller unavailable: ${(err as Error).message}`,
      });
      res.writeHead(502, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(msg),
      });
      res.end(msg);
    }
  });

  // If client disconnects early, abort upstream request
  res.on("close", () => {
    if (!completed) {
      proxyReq.destroy();
    }
  });

  req.pipe(proxyReq);
}

/**
 * Proxy WebSocket connection upgrades to the Mihomo controller stream endpoints
 * (e.g. /core/api/traffic, /core/api/logs).
 */
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

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const statusLine = `HTTP/1.1 ${proxyRes.statusCode ?? 101} ${proxyRes.statusMessage ?? "Switching Protocols"}\r\n`;
    const headerLines = Object.entries(proxyRes.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("\r\n");
    socket.write(`${statusLine}${headerLines}\r\n\r\n`);

    if (proxyHead.length > 0) socket.write(proxyHead);
    if (head.length > 0) proxySocket.write(head);

    const cleanup = () => {
      proxySocket.destroy();
      socket.destroy();
    };

    proxySocket.on("error", cleanup);
    proxySocket.on("close", () => socket.destroy());
    socket.on("error", cleanup);
    socket.on("close", () => proxySocket.destroy());

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  // Upstream rejected upgrade (e.g. HTTP 401/404/500)
  proxyReq.on("response", (proxyRes) => {
    const statusLine = `HTTP/1.1 ${proxyRes.statusCode ?? 502} ${proxyRes.statusMessage ?? "Bad Gateway"}\r\n\r\n`;
    socket.write(statusLine);
    socket.destroy();
    proxyRes.resume(); // drain response body
  });

  proxyReq.on("timeout", () => {
    proxyReq.destroy();
    socket.destroy();
  });

  proxyReq.on("error", () => {
    socket.destroy();
  });

  proxyReq.end();
}
