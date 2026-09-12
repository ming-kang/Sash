import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { sashLayout } from "../paths.js";
import { acquireStateLock } from "../state-lock.js";
import { createTestState, testSettings } from "../testing/state.js";
import { runStart, runStop } from "./lifecycle.js";

describe("lifecycle commands", () => {
  let root: string;
  let previousHome: string | undefined;
  let server: http.Server;
  let releaseLease: () => void;
  let port: number;
  let requests: { url: string; body: string }[];
  let progressResponse: unknown;
  let startGate: Promise<void> | undefined;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-command-test-"));
    previousHome = process.env.SASH_HOME;
    process.env.SASH_HOME = root;
    const layout = sashLayout(root);
    requests = [];
    progressResponse = null;
    startGate = undefined;
    const lease = await acquireStateLock(layout.daemonLeaseFile, { purpose: "test daemon" });
    releaseLease = () => lease.release();
    server = http.createServer(async (req, res) => {
      if (req.url !== "/sash/daemon/health")
        assert.equal(req.headers.authorization, "Bearer test-daemon-secret");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString() });
      if (req.method === "POST" && req.url === "/sash/core/start" && startGate) await startGate;
      if (req.method === "POST" && req.url === "/sash/core/start") progressResponse = null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url === "/sash/daemon/health"
            ? {
                ok: true,
                token: lease.record.token,
                pid: process.pid,
                startedAt: "2026-09-08T00:00:00.000Z",
              }
            : req.url === "/sash/core/update" && req.method === "GET"
              ? progressResponse
              : req.url === "/sash/core/update"
                ? { version: "v1.2.3" }
                : { pid: 77, version: "v1.2.3" },
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    port = address.port;
    createTestState(layout, testSettings());
    fs.writeFileSync(
      layout.daemonPidFile,
      JSON.stringify({
        pid: process.pid,
        token: lease.record.token,
        port,
        startedAt: "2026-09-08T00:00:00.000Z",
      }),
    );
  });

  afterEach(async () => {
    releaseLease();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousHome === undefined) delete process.env.SASH_HOME;
    else process.env.SASH_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts Core through the observed daemon port and prints that endpoint", async (t) => {
    const output: string[] = [];
    t.mock.method(console, "log", (...args: unknown[]) => output.push(args.map(String).join(" ")));
    await runStart();
    assert.equal(requests.filter((request) => request.url === "/sash/core/start").length, 1);
    assert.ok(
      output.some((line) => line.includes("local API") && line.includes(`127.0.0.1:${port}`)),
    );
  });

  it("prints Core download progress while the daemon installs", async (t) => {
    const lines: string[] = [];
    t.mock.method(
      process.stderr,
      "write",
      ((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stderr.write,
    );
    let releaseStart!: () => void;
    startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    progressResponse = {
      stage: "downloading",
      startedAt: "2026-09-08T00:00:00.000Z",
      target: "v1.2.3",
      downloading: true,
      downloaded: 1048576,
      total: 2097152,
    };
    const starting = runStart();
    await new Promise((resolve) => setTimeout(resolve, 650));
    releaseStart();
    await starting;
    assert.ok(
      lines.some((line) => line.includes("Downloading Core (v1.2.3): 1.0 / 2.0 MiB")),
      `expected download progress in stderr: ${lines.join("")}`,
    );
  });

  it("refuses an unverified stop without sending a shutdown request", async () => {
    releaseLease();
    await assert.rejects(runStop(), /refusing an unverified stop/);
    assert.deepEqual(requests, []);
  });
});
