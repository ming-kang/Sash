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
