import assert from "node:assert/strict";
import http from "node:http";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  extractConnectRefusedEndpoint,
  fetchWithRetry,
  formatProxyFallbackFailure,
  formatProxyFallbackWarning,
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
      "proxy 127.0.0.1:7890 refused connection — check whether that proxy is running, or unset HTTP_PROXY",
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

  it("formats proxy fallback warnings and combined failures", () => {
    const warning = formatProxyFallbackWarning({
      proxy: { address: "127.0.0.1", port: 7890 },
      url: "https://registry.npmjs.org/@astralyn/sash",
    });
    assert.equal(warning, "proxy 127.0.0.1:7890 refused connection — retrying without proxy");

    const failure = formatProxyFallbackFailure(
      { address: "127.0.0.1", port: 7890 },
      new Error("boom"),
    );
    assert.equal(
      failure.message,
      "proxy 127.0.0.1:7890 refused connection · direct request also failed: boom — check HTTP_PROXY or your network connection",
    );
  });
});

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];

async function listenOnEphemeralPort(target: http.Server): Promise<number> {
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  return typeof address === "object" && address ? address.port : 0;
}

/** Reserve and release a loopback port so nothing listens on it afterwards. */
async function deadLoopbackPort(): Promise<number> {
  const probe = http.createServer();
  const port = await listenOnEphemeralPort(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("loopback proxy fallback", () => {
  let server: http.Server;
  let port = 0;
  let deadPort = 0;
  let savedProxyEnv: Array<[string, string | undefined]>;

  before(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("direct-ok");
    });
    port = await listenOnEphemeralPort(server);
    deadPort = await deadLoopbackPort();

    // The proxy dispatcher reads the environment on first use and is cached
    // for the process, so it must be pinned before any proxied request.
    savedProxyEnv = PROXY_ENV_KEYS.map((key) => [key, process.env[key]]);
    for (const key of PROXY_ENV_KEYS) delete process.env[key];
    process.env.HTTP_PROXY = `http://127.0.0.1:${deadPort}`;
  });

  after(async () => {
    for (const [key, value] of savedProxyEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("warns and retries without the proxy after a loopback refusal", async () => {
    const warnings: string[] = [];
    const response = await fetchWithRetry(`http://127.0.0.1:${port}/`, {
      attempts: 1,
      onProxyFallback: (info) =>
        warnings.push(`${info.proxy.address}:${info.proxy.port} -> ${info.url}`),
    });
    assert.equal(await response.text(64), "direct-ok");
    assert.deepEqual(warnings, [`127.0.0.1:${deadPort} -> http://127.0.0.1:${port}/`]);
  });

  it("stays strict when no fallback listener is set", async () => {
    await assert.rejects(
      fetchWithRetry(`http://127.0.0.1:${port}/`, { attempts: 1 }),
      /refused connection — check whether that proxy is running, or unset HTTP_PROXY/,
    );
  });

  it("reports both failures when the direct retry also fails", async () => {
    const deadTarget = await deadLoopbackPort();
    await assert.rejects(
      fetchWithRetry(`http://127.0.0.1:${deadTarget}/`, {
        attempts: 1,
        onProxyFallback: () => undefined,
      }),
      /refused connection · direct request also failed: .* — check HTTP_PROXY or your network connection/,
    );
  });
});
