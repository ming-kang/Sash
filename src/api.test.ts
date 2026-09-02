import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { MihomoApi } from "./api.js";

describe("MihomoApi", () => {
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

  it("reads the actual TUN runtime state and rejects malformed config responses", async () => {
    let response: unknown = { tun: { enable: true } };
    const server = http.createServer((req, res) => {
      if (req.url === "/configs") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
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
      assert.equal(await api.getTunActive(), true);
      response = { tun: { enable: false } };
      assert.equal(await api.getTunActive(), false);
      response = { tun: { enable: "false" } };
      await assert.rejects(api.getTunActive(), /missing boolean tun\.enable/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses the upstream force query and drains a successful reload response", async () => {
    let requestBody = "";
    const server = http.createServer((req, res) => {
      if (req.method === "PUT" && req.url === "/configs?force=true") {
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
      await api.reloadConfig("/tmp/config.yaml");
      assert.ok(Date.now() - started >= 40, "reload resolved before its response body was drained");
      assert.deepEqual(JSON.parse(requestBody), { path: "/tmp/config.yaml" });
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
