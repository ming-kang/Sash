import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { sashLayout } from "../paths.js";
import { acquireStateLockSync } from "../state-lock.js";
import { createTestState, testSettings } from "../test-state.test.js";
import { runRestart, runStart, runStop } from "./lifecycle.js";
import { runUpdate } from "./update.js";

describe("lifecycle commands", () => {
  let root: string;
  let previousHome: string | undefined;
  let server: http.Server;
  let releaseLease: () => void;
  let port: number;
  let requests: { url: string; body: string }[];

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-command-test-"));
    previousHome = process.env.SASH_HOME;
    process.env.SASH_HOME = root;
    const layout = sashLayout(root);
    requests = [];
    const lease = acquireStateLockSync(layout.daemonLeaseFile, { purpose: "test daemon" });
    releaseLease = () => lease.release();
    server = http.createServer(async (req, res) => {
      if (req.url !== "/sash/daemon/health")
        assert.equal(req.headers.authorization, "Bearer test-daemon-secret");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString() });
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
      output.some((line) => line.includes("sash api") && line.includes(`127.0.0.1:${port}`)),
    );
  });

  it("restarts Core without shutting down the management daemon", async () => {
    await runRestart();
    assert.deepEqual(
      requests.filter((request) => request.url !== "/sash/daemon/health"),
      [{ url: "/sash/core/restart", body: "" }],
    );
  });

  it("updates through the daemon without a maintenance handoff", async () => {
    await runUpdate({ version: "v1.2.3" });
    const mutations = requests.filter((request) => request.url !== "/sash/daemon/health");
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0]?.url, "/sash/core/update");
    assert.deepEqual(JSON.parse(mutations[0]?.body ?? ""), { version: "v1.2.3" });
  });

  it("refuses an unverified stop without sending a shutdown request", async () => {
    releaseLease();
    await assert.rejects(runStop(), /refusing an unverified stop/);
    assert.deepEqual(requests, []);
  });
});
