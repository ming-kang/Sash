import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { envProxyUri, proxyDispatcherFor } from "./http.js";
import { downloadToFile } from "./http-download.js";

/**
 * Explicit proxy URIs. `downloadToFile` honours a requested URI instead of the
 * environment, which is how a running Core serves as the download transport;
 * the environment is pinned empty for the whole file so only the explicit URI
 * can route the request.
 */

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];

describe("explicit proxy URI downloads", () => {
  let origin: http.Server;
  let proxy: http.Server;
  let originUrl: string;
  let proxyUrl: string;
  let tmpDir: string;
  let savedProxyEnv: Array<[string, string | undefined]>;
  let proxiedRequests: string[];

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-proxy-uri-"));
    origin = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end("payload-bytes");
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const originAddress = origin.address();
    const originPort = typeof originAddress === "object" && originAddress ? originAddress.port : 0;
    originUrl = `http://127.0.0.1:${originPort}/payload`;

    proxiedRequests = [];
    proxy = http.createServer((req, res) => {
      proxiedRequests.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end("payload-bytes");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyAddress = proxy.address();
    const proxyPort = typeof proxyAddress === "object" && proxyAddress ? proxyAddress.port : 0;
    proxyUrl = `http://127.0.0.1:${proxyPort}`;

    savedProxyEnv = PROXY_ENV_KEYS.map((key) => [key, process.env[key]]);
    for (const key of PROXY_ENV_KEYS) delete process.env[key];
  });

  after(async () => {
    for (const [key, value] of savedProxyEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    origin.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => origin.close(() => resolve())),
      new Promise<void>((resolve) => proxy.close(() => resolve())),
    ]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("routes through the requested proxy and reports no environment proxy", async () => {
    assert.equal(envProxyUri(), undefined);
    const dest = path.join(tmpDir, "proxied.bin");
    const bytes = await downloadToFile(originUrl, dest, {
      allowedHosts: new Set(["127.0.0.1"]),
      proxyUri: proxyUrl,
    });
    assert.equal(bytes, "payload-bytes".length);
    assert.equal(fs.readFileSync(dest, "utf8"), "payload-bytes");
    assert.deepEqual(proxiedRequests, [originUrl]);
  });

  it("goes direct when no proxy is requested and none is configured", async () => {
    const dest = path.join(tmpDir, "direct.bin");
    const before = proxiedRequests.length;
    await downloadToFile(originUrl, dest, { allowedHosts: new Set(["127.0.0.1"]) });
    assert.equal(proxiedRequests.length, before);
  });

  it("caches one dispatcher per proxy URI", () => {
    assert.equal(proxyDispatcherFor(proxyUrl), proxyDispatcherFor(proxyUrl));
    assert.notEqual(
      proxyDispatcherFor(proxyUrl),
      proxyDispatcherFor(proxyUrl.replace("127.0.0.1", "localhost")),
    );
  });
});
