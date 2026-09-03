import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { describe, it } from "node:test";
import { useDaemonTestHarness } from "./daemon-test-harness.test.js";

describe("daemon server", () => {
  const h = useDaemonTestHarness();

  describe("/core/api/* reverse proxy", () => {
    it("rejects every unauthenticated Core GET before opening an upstream request", async () => {
      let upstreamRequests = 0;
      h.mockCoreServer = http.createServer((_req, res) => {
        upstreamRequests++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
      await new Promise<void>((resolve) => {
        h.mockCoreServer?.listen(0, "127.0.0.1", () => resolve());
      });
      const address = h.mockCoreServer.address();
      h.mockCorePort = typeof address === "object" && address ? address.port : 0;
      h.settings.controller = `127.0.0.1:${h.mockCorePort}`;
      await h.startServer();

      const delay = await h.apiRequest(
        "/core/api/proxies/DIRECT/delay?url=http%3A%2F%2F192.168.1.1%2Faction",
        { token: "" },
      );
      const fallback = await h.apiRequest("/version", { token: "" });

      assert.equal(delay.statusCode, 401);
      assert.equal(fallback.statusCode, 401);
      assert.equal(upstreamRequests, 0);
    });

    it("injects the core authorization and strips daemon control credentials", async () => {
      let receivedAuth: string | undefined;
      let receivedWebToken: string | undefined;
      let receivedPath: string | undefined;

      // Start a mock Core external-controller server
      h.mockCoreServer = http.createServer((req, res) => {
        receivedAuth = req.headers.authorization;
        receivedWebToken = req.headers["x-sash-token"] as string | undefined;
        receivedPath = req.url;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "v1.19.30-meta" }));
      });

      await new Promise<void>((resolve) => {
        h.mockCoreServer?.listen(0, "127.0.0.1", () => resolve());
      });

      const addr = h.mockCoreServer.address();
      h.mockCorePort = typeof addr === "object" && addr ? addr.port : 0;
      h.settings.controller = `127.0.0.1:${h.mockCorePort}`;

      const inst = await h.startServer();

      // Call /core/api/version with the WebUI credential via sashd.
      const res = await h.apiRequest("/core/api/version", {
        token: "",
        webToken: inst.token,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(receivedPath, "/version");
      assert.equal(receivedAuth, `Bearer ${h.settings.secret}`);
      assert.equal(receivedWebToken, undefined);
      assert.deepEqual(res.data, { version: "v1.19.30-meta" });

      const invalidPrefix = await h.apiRequest("/core/apiX/version");
      assert.equal(invalidPrefix.statusCode, 404);
    });

    it("forwards one canonical parsed target without duplicating its query", async () => {
      const receivedPaths: string[] = [];
      h.mockCoreServer = http.createServer((req, res) => {
        receivedPaths.push(req.url ?? "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
      await new Promise<void>((resolve) => {
        h.mockCoreServer?.listen(0, "127.0.0.1", () => resolve());
      });
      const address = h.mockCoreServer.address();
      h.mockCorePort = typeof address === "object" && address ? address.port : 0;
      h.settings.controller = `127.0.0.1:${h.mockCorePort}`;
      await h.startServer();

      for (const pathname of [
        "/core/api?x=1",
        "/core/api///?x=2",
        "/core/api/proxies/a%2Fb?x=%2F",
      ]) {
        assert.equal((await h.apiRequest(pathname)).statusCode, 200, pathname);
      }
      assert.deepEqual(receivedPaths, ["/?x=1", "/?x=2", "/proxies/a%2Fb?x=%2F"]);

      const encodedDot = await h.apiRequest("/core/api/%2e%2e/version");
      assert.equal(encodedDot.statusCode, 404);
      assert.equal(receivedPaths.length, 3);
    });

    it("rejects unauthenticated WebSocket upgrades", async () => {
      await h.startServer();
      const response = await h.rawWebSocketUpgrade("/core/api/logs");
      assert.match(response, /^HTTP\/1\.1 401 Unauthorized WebSocket request/);
    });

    it("closes the upstream when the client disconnects before the 101 response", async () => {
      let resolveAccepted: (() => void) | undefined;
      const accepted = new Promise<void>((resolve) => {
        resolveAccepted = resolve;
      });
      let resolveUpstreamEnded: (() => void) | undefined;
      let rejectUpstreamEnded: ((reason: Error) => void) | undefined;
      const upstreamEnded = new Promise<void>((resolve, reject) => {
        resolveUpstreamEnded = resolve;
        rejectUpstreamEnded = reject;
      });
      let upstreamSocket: Duplex | undefined;
      h.mockCoreServer = http.createServer();
      h.mockCoreServer.on("upgrade", (_req, socket) => {
        upstreamSocket = socket;
        socket.once("end", () => resolveUpstreamEnded?.());
        socket.once("close", () => resolveUpstreamEnded?.());
        socket.on("readable", () => {
          while (socket.read() !== null) {
            // Consume until EOF so the peer close is observable.
          }
        });
        resolveAccepted?.();
      });
      await new Promise<void>((resolve) => {
        h.mockCoreServer?.listen(0, "127.0.0.1", () => resolve());
      });
      const address = h.mockCoreServer.address();
      h.mockCorePort = typeof address === "object" && address ? address.port : 0;
      h.settings.controller = `127.0.0.1:${h.mockCorePort}`;
      await h.startServer();

      const client = net.createConnection({ host: "127.0.0.1", port: h.boundPort });
      client.on("error", () => undefined);
      try {
        await new Promise<void>((resolve, reject) => {
          client.once("connect", resolve);
          client.once("error", reject);
        });
        client.write(
          "GET /core/api/logs HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${h.boundPort}\r\n` +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            `Authorization: Bearer ${h.settings.daemonSecret}\r\n\r\n`,
        );
        await accepted;
        client.destroy();

        const deadline = setTimeout(
          () => rejectUpstreamEnded?.(new Error("upstream WebSocket did not receive EOF")),
          1000,
        );
        try {
          await upstreamEnded;
        } finally {
          clearTimeout(deadline);
        }
        assert.equal(upstreamSocket?.readableEnded || upstreamSocket?.destroyed, true);
      } finally {
        client.destroy();
        upstreamSocket?.destroy();
      }
    });

    it("completes WebSocket auth negotiation with the canonical Core target", async () => {
      let receivedProtocols: string | undefined;
      let receivedPath: string | undefined;
      h.mockCoreServer = http.createServer();
      h.mockCoreServer.on("upgrade", (req, socket) => {
        receivedProtocols = req.headers["sec-websocket-protocol"];
        receivedPath = req.url;
        socket.end(
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

      const inst = await h.startServer();
      const response = await h.rawWebSocketUpgrade("/core/api/logs?level=info", {
        Origin: `http://127.0.0.1:${h.boundPort}`,
        "Sec-WebSocket-Protocol": `sash, sash-token.${inst.token}`,
      });

      assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
      assert.match(response, /\r\nsec-websocket-protocol: sash\r\n/i);
      assert.equal(receivedProtocols, undefined);
      assert.equal(receivedPath, "/logs?level=info");
    });
  });
});
