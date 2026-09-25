import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { describe, it } from "node:test";
import { useDaemonTestHarness } from "../testing/daemon-harness.js";

function openUpgrade(
  port: number,
  secret: string,
): Promise<{ socket: net.Socket; status: number; headers: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("WebSocket upgrade timed out"));
    }, 5000);
    socket.on("connect", () => {
      socket.write(
        "GET /core/api/logs HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          `Authorization: Bearer ${secret}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        clearTimeout(timeout);
        const headerText = buffer.slice(0, headerEnd);
        const match = headerText.match(/^HTTP\/1\.1 (\d+)/);
        const status = match ? Number(match[1]) : 0;
        resolve({ socket, status, headers: headerText });
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("daemon server WebSocket cap", () => {
  const h = useDaemonTestHarness();

  it("rejects 65th concurrent WebSocket upgrade with 503 while 64 succeed", async () => {
    const coreSockets: net.Socket[] = [];
    h.mockCoreServer = http.createServer();
    h.mockCoreServer.on("upgrade", (_req, socket) => {
      coreSockets.push(socket as net.Socket);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
      );
    });
    await new Promise<void>((resolve) => {
      h.mockCoreServer?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = h.mockCoreServer.address();
    h.mockCorePort = typeof address === "object" && address ? address.port : 0;
    h.settings.controller = `127.0.0.1:${h.mockCorePort}`;

    await h.startServer();

    const clientSockets: net.Socket[] = [];
    try {
      for (let i = 0; i < 64; i++) {
        const client = await openUpgrade(h.boundPort, h.settings.daemonSecret);
        clientSockets.push(client.socket);
        assert.equal(client.status, 101, `upgrade ${i + 1} should succeed with 101`);
      }

      const sixtyFifth = await h.rawWebSocketUpgrade("/core/api/logs", {
        Authorization: `Bearer ${h.settings.daemonSecret}`,
      });
      assert.match(sixtyFifth, /^HTTP\/1\.1 503 Service Unavailable/);
      assert.match(sixtyFifth, /"code":"shutting_down"/);
      assert.match(sixtyFifth, /"message":"WebSocket streams are unavailable; reconnect shortly"/);

      const released = clientSockets.pop();
      released?.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const reopened = await openUpgrade(h.boundPort, h.settings.daemonSecret);
      clientSockets.push(reopened.socket);
      assert.equal(reopened.status, 101, "upgrade should succeed after slot is released");
    } finally {
      for (const socket of clientSockets) socket.destroy();
      for (const socket of coreSockets) socket.destroy();
    }
  });
});
