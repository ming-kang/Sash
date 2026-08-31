import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { Duplex } from "node:stream";

export function parseHostPort(address: string): { host: string; port: number } {
  const trimmed = address.trim();
  const match = trimmed.match(/^(?:https?:\/\/)?(?:\[([0-9a-fA-F:]+)\]|([^:]+)):(\d+)$/);
  if (match) {
    const host = match[1] ?? match[2] ?? "127.0.0.1";
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
  if (secret) {
    upstreamHeaders.authorization = `Bearer ${secret}`;
  }

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
    },
  );

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
  if (secret) {
    upstreamHeaders.authorization = `Bearer ${secret}`;
  }

  const proxyReq = http.request({
    hostname: host,
    port,
    path: targetPath,
    method: "GET",
    headers: upstreamHeaders,
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const statusLine = `HTTP/1.1 ${proxyRes.statusCode ?? 101} ${proxyRes.statusMessage ?? "Switching Protocols"}\r\n`;
    const headerLines = Object.entries(proxyRes.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("\r\n");
    socket.write(`${statusLine}${headerLines}\r\n\r\n`);

    if (proxyHead.length > 0) socket.write(proxyHead);
    if (head.length > 0) proxySocket.write(head);

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on("error", () => {
    socket.destroy();
  });

  proxyReq.end();
}
