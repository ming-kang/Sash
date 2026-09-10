import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { createDaemonClient } from "./daemon-client.js";
import { testProfile } from "./testing/state.js";

describe("daemon client mutation requests", () => {
  it("reads a profile library that fits the application manifest limit", async () => {
    const index = {
      activeId: null,
      profiles: Array.from({ length: 6000 }, (_, i) => testProfile(String(i + 1))),
    };
    const body = JSON.stringify(index);
    assert.ok(Buffer.byteLength(body) > 1024 * 1024);
    assert.ok(Buffer.byteLength(body) < 2 * 1024 * 1024);
    const server = http.createServer((req, res) => {
      assert.equal(req.url, "/sash/profiles");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      assert.deepEqual(
        await createDaemonClient(address.port, "fixture-secret").listProfiles(),
        index,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("authenticates daemon shutdown", async () => {
    let authorization: string | undefined;
    const server = http.createServer((req, res) => {
      authorization = req.headers.authorization;
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/sash/daemon/shutdown");
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      await createDaemonClient(port, "maintenance-secret").shutdown();
      assert.equal(authorization, "Bearer maintenance-secret");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("propagates a shutdown cleanup failure", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "internal", message: "proxy restoration failed" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      await assert.rejects(createDaemonClient(port, "").shutdown(), /proxy restoration failed/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not retry POST mutations by default", async () => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/sash/core/start") requests += 1;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { code: "shutting_down", message: "temporarily unavailable" } }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const client = createDaemonClient(port, "");
      await assert.rejects(() => client.startCore(), /temporarily unavailable/);
      assert.equal(requests, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
