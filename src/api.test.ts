import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { MihomoApi } from "./api.js";
import { ERROR_BODY_LIMIT } from "./http.js";
import { fetchSubscriptionProfile } from "./mihomo-config.js";

describe("MihomoApi", () => {
  it("never follows controller redirects carrying private credentials", async () => {
    const paths: string[] = [];
    const server = http.createServer((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(307, { Location: "/other-controller" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      await assert.rejects(
        new MihomoApi(`127.0.0.1:${address.port}`, "private").version(),
        /HTTP 307/,
      );
      assert.deepEqual(paths, ["/version"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("preserves controller and subscription HTTP failures with oversized response bodies", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(403);
      res.end("x".repeat(ERROR_BODY_LIMIT + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      const api = new MihomoApi(`127.0.0.1:${address.port}`, "");
      await assert.rejects(api.version(), /HTTP 403/);
      await assert.rejects(api.setMode("rule"), /HTTP 403/);
      await assert.rejects(fetchSubscriptionProfile(`${api.baseUrl}/profile`), /HTTP 403/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("normalizes controller URL without protocol", () => {
    const api = new MihomoApi("127.0.0.1:9090", "secret");
    assert.equal(api.baseUrl, "http://127.0.0.1:9090");
  });

  it("falls back to default controller if empty", () => {
    const api = new MihomoApi("", "");
    assert.equal(api.baseUrl, "http://127.0.0.1:9090");
  });

  it("rejects non-loopback controllers before sending credentials", () => {
    assert.throws(() => new MihomoApi("controller.example:9090", "secret"), /loopback host:port/);
    assert.throws(() => new MihomoApi("0.0.0.0:9090", "secret"), /loopback host:port/);
  });

  it("queries version and checks reachability", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/version" && req.headers.authorization === "Bearer test-secret") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "v1.19.30-meta" }));
        return;
      }
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const api = new MihomoApi(`127.0.0.1:${port}`, "test-secret");
      const reachable = await api.isReachable();
      assert.equal(reachable, true);

      const ver = await api.version();
      assert.equal(ver, "v1.19.30-meta");

      const badApi = new MihomoApi(`127.0.0.1:${port}`, "wrong-secret");
      const badReachable = await badApi.isReachable();
      assert.equal(badReachable, false);
    } finally {
      server.close();
    }
  });

  it("changes mode through the controller and drains its response", async () => {
    let requestBody = "";
    const server = http.createServer((req, res) => {
      if (req.method === "PATCH" && req.url === "/configs") {
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          requestBody += chunk;
        });
        req.on("end", () => {
          res.writeHead(200);
          setTimeout(() => res.end("reload complete"), 50);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const api = new MihomoApi(`127.0.0.1:${port}`, "");
      const started = Date.now();
      await api.setMode("rule");
      assert.ok(Date.now() - started >= 40, "reload resolved before its response body was drained");
      assert.deepEqual(JSON.parse(requestBody), { mode: "rule" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects successful responses without a version string", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ meta: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const api = new MihomoApi(`127.0.0.1:${port}`, "");
      await assert.rejects(api.version(), /missing a non-empty version/);
      assert.equal(await api.isReachable(), false);
    } finally {
      server.close();
    }
  });
});
