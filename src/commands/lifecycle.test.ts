import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { sashLayout } from "../paths.js";
import { DEFAULT_SETTINGS, saveSettings } from "../settings.js";
import { acquireStateLockSync } from "../state-lock.js";
import { runStart, runStop } from "./lifecycle.js";

let root: string | undefined;
let previousSashHome: string | undefined;
let server: http.Server | undefined;
let releaseLease: (() => void) | undefined;

afterEach(async () => {
  releaseLease?.();
  releaseLease = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  if (previousSashHome === undefined) delete process.env.SASH_HOME;
  else process.env.SASH_HOME = previousSashHome;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("lifecycle commands", () => {
  it("calls startCore even when the daemon would report an already healthy Core", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-command-start-test-"));
    previousSashHome = process.env.SASH_HOME;
    process.env.SASH_HOME = root;
    const layout = sashLayout(root);
    let startCalls = 0;
    let daemonToken = "";
    server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/sash/health") {
        res.end(JSON.stringify({ ok: true, token: daemonToken, pid: process.pid }));
        return;
      }
      if (req.url === "/sash/status") {
        res.end(JSON.stringify({ core: { running: true, healthy: true, pid: 77 } }));
        return;
      }
      if (req.url === "/core/start") {
        startCalls++;
        res.end(JSON.stringify({ ok: true, pid: 77, version: "v-test", tunActive: false }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const settings = {
      ...DEFAULT_SETTINGS,
      daemonPort: port,
      tun: true,
      secret: "test-core-secret",
      daemonSecret: "test-daemon-secret",
    };
    saveSettings(settings, layout);
    const lease = acquireStateLockSync(layout.daemonLeaseFile, { purpose: "test daemon" });
    releaseLease = () => lease.release();
    daemonToken = lease.record.token;
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(
      layout.daemonPidFile,
      `${JSON.stringify({
        pid: process.pid,
        token: lease.record.token,
        port,
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    const daemon = await evaluateDaemon(layout, settings);
    assert.equal(daemon.healthy, true, JSON.stringify(daemon));
    const warnings: string[] = [];
    const previousWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      await runStart();
    } finally {
      console.warn = previousWarn;
    }

    assert.equal(startCalls, 1);
    assert.match(warnings.join("\n"), /TUN was requested but is inactive/);
    assert.match(warnings.join("\n"), /sash restart.*alone does not elevate sashd/);
  });

  it("rejects stop when daemon shutdown cannot be verified", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-command-stop-test-"));
    previousSashHome = process.env.SASH_HOME;
    process.env.SASH_HOME = root;
    const layout = sashLayout(root);
    saveSettings(
      { ...DEFAULT_SETTINGS, secret: "test-core-secret", daemonSecret: "test-daemon-secret" },
      layout,
    );
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(
      layout.daemonPidFile,
      `${JSON.stringify({
        pid: process.pid,
        token: "unverified-token",
        port: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    await assert.rejects(runStop(), /could not be stopped safely/);
  });
});
