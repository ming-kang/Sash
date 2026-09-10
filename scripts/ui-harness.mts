/**
 * Shared scaffolding for the manual Playwright verification scripts.
 *
 * Each script still owns its assertions and fixtures; this module owns the
 * parts they repeated: artifact directories, the mock Core HTTP/WebSocket
 * listener, browser launch and failure captures.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { type Browser, type BrowserType, chromium, firefox } from "playwright";
import { buildSanitizedEnv } from "../src/process.js";

export const UI_ENGINES: ReadonlyArray<{ engine: BrowserType; name: string }> = [
  { engine: chromium, name: "chromium" },
  { engine: firefox, name: "firefox" },
];

/** Artifact directory: first argument when given, otherwise a fresh temp directory. */
export function uiArtifactDirectory(prefix: string): string {
  const output = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(output, { recursive: true });
  return output;
}

/** RFC 6455 text frame for mock Core stream messages. */
export function webSocketTextFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(body.length < 126 ? 2 : 4);
  prefix[0] = 0x81;
  prefix[1] = body.length < 126 ? body.length : 126;
  if (body.length >= 126) prefix.writeUInt16BE(body.length, 2);
  return Buffer.concat([prefix, body]);
}

export function acceptWebSocketUpgrade(req: http.IncomingMessage, socket: Duplex): void {
  const accept = crypto
    .createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
}

export interface MockCore {
  port: number;
  sockets: Set<Duplex>;
  close(): Promise<void>;
}

export interface MockCoreOptions {
  handle(req: http.IncomingMessage, res: http.ServerResponse): void;
  /** Called for each accepted WebSocket upgrade; `send` writes one text frame. */
  stream?(req: http.IncomingMessage, socket: Duplex, send: (value: unknown) => void): void;
}

/** Loopback Core stand-in: the caller owns HTTP routing, the harness owns the listener. */
export async function startMockCore(options: MockCoreOptions): Promise<MockCore> {
  const sockets = new Set<Duplex>();
  const server = http.createServer(options.handle);
  server.on("upgrade", (req, socket) => {
    const connection = socket as Duplex;
    sockets.add(connection);
    connection.on("error", () => undefined);
    connection.on("close", () => sockets.delete(connection));
    acceptWebSocketUpgrade(req, connection);
    connection.on("data", () => undefined);
    options.stream?.(req, connection, (value) => {
      if (!connection.destroyed) connection.write(webSocketTextFrame(value));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Mock Core did not bind loopback");
  return {
    port: address.port,
    sockets,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function launchUiBrowser(engine: BrowserType, headless = true): Promise<Browser> {
  return engine.launch({ headless, env: buildSanitizedEnv() });
}

/** Capture every open page of a browser that failed verification. */
export async function captureFailurePages(
  browser: Browser,
  output: string,
  tag: string,
): Promise<void> {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      await page
        .screenshot({ path: path.join(output, `${tag}-failure.png`), fullPage: true })
        .catch(() => undefined);
    }
  }
}
