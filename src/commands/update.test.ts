import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { sashLayout } from "../paths.js";
import { acquireStateLock } from "../state-lock.js";
import { createTestState, testSettings } from "../testing/state.js";
import { runUpdate } from "./update.js";

describe("update command cancellation", () => {
  let root: string;
  let previousHome: string | undefined;
  let server: http.Server;
  let releaseLease: () => void;
  let port: number;
  let requests: { method: string; url: string }[];
  let updateGate: Promise<void> | undefined;
  let releaseUpdate: (() => void) | undefined;
  let updateResponse: Record<string, unknown> = { version: "v1.19.31" };
  let progressResponse: unknown = null;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-update-cancel-"));
    previousHome = process.env.SASH_HOME;
    process.env.SASH_HOME = root;
    const layout = sashLayout(root);
    requests = [];
    const lease = await acquireStateLock(layout.daemonLeaseFile, { purpose: "test daemon" });
    releaseLease = () => lease.release();
    server = http.createServer(async (req, res) => {
      requests.push({ method: req.method ?? "", url: req.url ?? "" });
      if (req.method === "DELETE" && req.url === "/sash/core/update") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "POST" && req.url === "/sash/core/update") {
        if (updateGate) await updateGate;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(updateResponse));
        return;
      }
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
            : req.url === "/sash/core/update"
              ? progressResponse
              : { version: "v1.19.31" },
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    port = address.port;
    createTestState(layout, testSettings({ daemonPort: port }));
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
    releaseUpdate?.();
    releaseLease();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousHome === undefined) delete process.env.SASH_HOME;
    else process.env.SASH_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("cancels the daemon download with --cancel and reports it", async (t) => {
    const output: string[] = [];
    t.mock.method(console, "log", (...args: unknown[]) => output.push(args.map(String).join(" ")));
    await runUpdate({ cancel: true });
    assert.deepEqual(
      requests.filter((request) => request.method === "DELETE"),
      [{ method: "DELETE", url: "/sash/core/update" }],
    );
    assert.ok(output.some((line) => line.includes("Core download cancelled")));
  });

  it("reports one machine-readable result for --cancel --json", async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runUpdate({ cancel: true, json: true });
    } finally {
      process.stdout.write = original;
    }
    const line = written.map((text) => text.trim()).find((text) => text.startsWith("{"));
    assert.deepEqual(JSON.parse(line ?? ""), { cancelled: true });
  });

  it("refuses --cancel together with --check", async () => {
    await assert.rejects(runUpdate({ cancel: true, check: true }), /drop --check/);
    assert.deepEqual(requests, []);
  });

  it("reports an already installed release without claiming an update", async (t) => {
    updateResponse = { version: "v1.19.31", alreadyCurrent: true };
    const output: string[] = [];
    t.mock.method(console, "log", (...args: unknown[]) => output.push(args.map(String).join(" ")));
    await runUpdate({});
    assert.ok(output.some((line) => line.includes("Core v1.19.31 is up to date")));
    assert.ok(!output.some((line) => line.includes("Core updated to")));
  });

  it("cancels the download and exits 130 when Ctrl+C interrupts an update", async (t) => {
    const output: string[] = [];
    t.mock.method(console, "log", (...args: unknown[]) => output.push(args.map(String).join(" ")));
    const errors: string[] = [];
    t.mock.method(process.stderr, "write", ((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    progressResponse = {
      stage: "downloading",
      startedAt: "2026-09-08T00:00:00.000Z",
      target: "v1.19.31",
      downloading: true,
      downloaded: 1048576,
      total: 21400000,
    };
    const previousExitCode = process.exitCode;
    const updating = runUpdate({});
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.emit("SIGINT");
    await updating;
    process.exitCode = previousExitCode;
    assert.ok(
      requests.some(
        (request) => request.method === "DELETE" && request.url === "/sash/core/update",
      ),
      `expected a cancel request: ${JSON.stringify(requests)}`,
    );
    assert.ok(errors.some((line) => line.includes("Cancelling the Core download")));
    assert.ok(output.some((line) => line.includes("Core download cancelled")));
  });

  it("keeps a plain interrupt when no Core download is running", async (t) => {
    const errors: string[] = [];
    t.mock.method(process.stderr, "write", ((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    progressResponse = null;
    const previousExitCode = process.exitCode;
    const updating = runUpdate({});
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.emit("SIGINT");
    await updating;
    process.exitCode = previousExitCode;
    assert.equal(
      requests.some((request) => request.method === "DELETE"),
      false,
      `expected no cancel request: ${JSON.stringify(requests)}`,
    );
    assert.equal(
      errors.some((line) => line.includes("Cancelling the Core download")),
      false,
    );
  });
});
