import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { downloadToFile, proxyAwareDispatcher, USER_AGENT } from "./http.js";

/**
 * Redirect allowlist enforcement in downloadToFile. Uses a loopback node:http
 * server; no external network access.
 */

describe("downloadToFile redirect allowlist", () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpDir: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-http-test-"));
    server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/start") {
        res.writeHead(302, { location: "/target" });
        res.end();
      } else if (url === "/target") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end("payload-bytes");
      } else if (url === "/evil") {
        res.writeHead(302, { location: "http://untrusted.example.com/payload.gz" });
        res.end();
      } else if (url.startsWith("/loop")) {
        const n = Number.parseInt(url.slice(5), 10);
        res.writeHead(302, { location: `/loop${n + 1}` });
        res.end();
      } else if (url === "/ua-check") {
        res.writeHead(200);
        res.end(req.headers["user-agent"] ?? "");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("follows a same-host redirect and downloads the payload", async () => {
    const dest = path.join(tmpDir, "ok.bin");
    const bytes = await downloadToFile(`${baseUrl}/start`, dest, {
      allowedHosts: new Set(["127.0.0.1"]),
    });
    assert.equal(bytes, "payload-bytes".length);
    assert.equal(fs.readFileSync(dest, "utf8"), "payload-bytes");
  });

  it("rejects a redirect to a host outside the allowlist and removes the partial file", async () => {
    const dest = path.join(tmpDir, "evil.bin");
    await assert.rejects(
      () => downloadToFile(`${baseUrl}/evil`, dest, { allowedHosts: new Set(["127.0.0.1"]) }),
      /untrusted\.example\.com/,
    );
    assert.equal(fs.existsSync(dest), false);
  });

  it("supports relative Location headers", async () => {
    const dest = path.join(tmpDir, "rel.bin");
    await downloadToFile(`${baseUrl}/start`, dest, {
      allowedHosts: new Set(["127.0.0.1"]),
    });
    assert.equal(fs.readFileSync(dest, "utf8"), "payload-bytes");
  });

  it("rejects after too many redirect hops", async () => {
    const dest = path.join(tmpDir, "loop.bin");
    await assert.rejects(
      () => downloadToFile(`${baseUrl}/loop0`, dest, { allowedHosts: new Set(["127.0.0.1"]) }),
      /Too many redirects/,
    );
    assert.equal(fs.existsSync(dest), false);
  });

  it("sends the sash user agent", async () => {
    const dest = path.join(tmpDir, "ua.bin");
    await downloadToFile(`${baseUrl}/ua-check`, dest);
    assert.equal(fs.readFileSync(dest, "utf8"), USER_AGENT);
  });
});

describe("proxy dispatcher environment purity", () => {
  it("does not mutate process.env when ALL_PROXY is set", () => {
    const before = { ...process.env };
    process.env.ALL_PROXY = "http://127.0.0.1:9";
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    try {
      proxyAwareDispatcher();
      assert.equal(process.env.HTTP_PROXY, undefined);
      assert.equal(process.env.HTTPS_PROXY, undefined);
      assert.equal(process.env.https_proxy, undefined);
    } finally {
      // Restore the original proxy environment for other tests.
      delete process.env.ALL_PROXY;
      if (before.HTTP_PROXY) process.env.HTTP_PROXY = before.HTTP_PROXY;
      if (before.HTTPS_PROXY) process.env.HTTPS_PROXY = before.HTTPS_PROXY;
    }
  });
});
