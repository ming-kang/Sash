import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { downloadToFile } from "./http-download.js";

/**
 * Loopback proxy refusal fallback in downloadToFile. HTTP_PROXY must point at
 * the dead port before the first proxied request creates the cached dispatcher,
 * so the environment is pinned in before() for the whole file.
 */

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

describe("downloadToFile loopback proxy fallback", () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpDir: string;
  let deadPort = 0;
  let savedProxyEnv: Array<[string, string | undefined]>;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-download-fallback-"));
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end("payload-bytes");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const probeAddress = probe.address();
    deadPort = typeof probeAddress === "object" && probeAddress ? probeAddress.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("warns and retries without the proxy after a loopback refusal", async () => {
    const warnings: string[] = [];
    const dest = path.join(tmpDir, "payload.bin");
    const bytes = await downloadToFile(`${baseUrl}/payload`, dest, {
      allowedHosts: new Set(["127.0.0.1"]),
      onProxyFallback: (info) => warnings.push(`${info.proxy.address}:${info.proxy.port}`),
    });
    assert.equal(bytes, "payload-bytes".length);
    assert.equal(fs.readFileSync(dest, "utf8"), "payload-bytes");
    assert.deepEqual(warnings, [`127.0.0.1:${deadPort}`]);
  });

  it("stays strict when no fallback listener is set", async () => {
    const dest = path.join(tmpDir, "strict.bin");
    await assert.rejects(
      downloadToFile(`${baseUrl}/payload`, dest, {
        allowedHosts: new Set(["127.0.0.1"]),
      }),
      /refused connection — check whether that proxy is running, or unset HTTP_PROXY/,
    );
    assert.equal(fs.existsSync(dest), false);
  });
});
