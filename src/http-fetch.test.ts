import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fetchWithRetry } from "./http.js";

describe("bounded fetch responses", () => {
  let server: http.Server;
  let port = 0;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/drip") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write(".");
        const interval = setInterval(() => res.write("."), 20);
        req.on("close", () => clearInterval(interval));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("1234567890");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns bodies within the requested limit", async () => {
    const response = await fetchWithRetry(`http://127.0.0.1:${port}`, {
      attempts: 1,
      direct: true,
    });
    assert.equal(await response.text(10), "1234567890");
  });

  it("rejects bodies that exceed the requested limit", async () => {
    const response = await fetchWithRetry(`http://127.0.0.1:${port}`, {
      attempts: 1,
      direct: true,
    });
    await assert.rejects(() => response.text(5), /exceeds 5 byte limit/);
  });

  it("aborts a slowly dripping body at the absolute deadline", async () => {
    const started = Date.now();
    const response = await fetchWithRetry(`http://127.0.0.1:${port}/drip`, {
      attempts: 1,
      direct: true,
      bodyInactivityTimeoutMs: 1_000,
      deadlineMs: 120,
    });
    await assert.rejects(() => response.text(1024));
    assert.ok(Date.now() - started < 600, "dripping body outlived its total deadline");
  });

  it("supports discard and rejects a second body operation", async () => {
    const response = await fetchWithRetry(`http://127.0.0.1:${port}`, {
      attempts: 1,
      direct: true,
    });
    await response.discard();
    await assert.rejects(() => response.text(10), /already been consumed or discarded/);
  });

  it("rejects repeated body consumption", async () => {
    const response = await fetchWithRetry(`http://127.0.0.1:${port}`, {
      attempts: 1,
      direct: true,
    });
    assert.equal(await response.text(10), "1234567890");
    await assert.rejects(() => response.buffer(10), /already been consumed or discarded/);
  });
});
