import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  extractConnectRefusedEndpoint,
  fetchWithRetry,
  formatProxyRefusedError,
  isLoopbackHost,
  isProxyConnectionRefused,
} from "./http.js";

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
    await assert.rejects(() => response.text(10), /already been consumed or discarded/);
  });
});

describe("proxy connection error classification", () => {
  it("identifies loopback host addresses", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("::1"), true);
    assert.equal(isLoopbackHost("[::1]"), true);
    assert.equal(isLoopbackHost("192.168.1.1"), false);
    assert.equal(isLoopbackHost("registry.npmjs.org"), false);
  });

  it("extracts connection refused endpoint from code, message, or cause", () => {
    const errorWithFields = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      address: "127.0.0.1",
      port: 7890,
    });
    assert.deepEqual(extractConnectRefusedEndpoint(errorWithFields), {
      address: "127.0.0.1",
      port: 7890,
    });

    const errorWithMessage = new Error("connect ECONNREFUSED 127.0.0.1:18890");
    assert.deepEqual(extractConnectRefusedEndpoint(errorWithMessage), {
      address: "127.0.0.1",
      port: 18890,
    });

    const nestedError = new Error("fetch failed", { cause: errorWithFields });
    assert.deepEqual(extractConnectRefusedEndpoint(nestedError), {
      address: "127.0.0.1",
      port: 7890,
    });
  });

  it("distinguishes proxy refusals from direct target refusals", () => {
    const refusedLocalProxy = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      address: "127.0.0.1",
      port: 7890,
    });
    // Remote target port is 443; endpoint is 7890 -> proxy refusal
    assert.equal(
      isProxyConnectionRefused(refusedLocalProxy, "https://registry.npmjs.org/@astralyn/sash"),
      true,
    );

    // Same local host and port -> direct connection refusal, not proxy
    assert.equal(isProxyConnectionRefused(refusedLocalProxy, "http://127.0.0.1:7890/test"), false);
  });

  it("formats actionable proxy refused errors", () => {
    const loopbackError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      address: "127.0.0.1",
      port: 7890,
    });
    const formattedLoopback = formatProxyRefusedError(loopbackError);
    assert.equal(
      formattedLoopback.message,
      "proxy 127.0.0.1:7890 refused connection — start Sash (sash start) or check HTTP_PROXY",
    );

    const remoteError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      address: "10.0.0.1",
      port: 8080,
    });
    const formattedRemote = formatProxyRefusedError(remoteError);
    assert.equal(
      formattedRemote.message,
      "proxy 10.0.0.1:8080 refused connection — check HTTP_PROXY",
    );
  });
});
