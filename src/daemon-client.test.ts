import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { SashDaemonClient } from "./daemon-client.js";

describe("SashDaemonClient mutation requests", () => {
  it("returns the typed maintenance shutdown snapshot", async () => {
    let authorization: string | undefined;
    const server = http.createServer((req, res) => {
      authorization = req.headers.authorization;
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/sash/maintenance/shutdown");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, coreWasRunning: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const result = await new SashDaemonClient(port, "maintenance-secret").maintenanceShutdown();
      assert.deepEqual(result, { ok: true, coreWasRunning: true });
      assert.equal(authorization, "Bearer maintenance-secret");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("propagates a shutdown cleanup failure", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "proxy restoration failed" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      await assert.rejects(
        new SashDaemonClient(port, "").shutdown(),
        /HTTP 500: proxy restoration failed/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not retry POST mutations by default", async () => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/sash/proxy/enable") requests += 1;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "temporarily unavailable" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const client = new SashDaemonClient(port, "");
      await assert.rejects(() => client.enableProxy(), /HTTP 503/);
      assert.equal(requests, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
