import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { request } from "undici";
import { test } from "vitest";
import { evaluateDaemon, stopDaemonFromCli } from "../daemon-lifecycle.js";
import { ensureDaemonSession, type HealthyDaemonSession } from "../daemon-session.js";
import { directDispatcherForLoopback } from "../http.js";
import { sashLayout } from "../paths.js";
import { createDaemonClient } from "../sash-client-node.js";
import { createTestState, testSettings } from "../testing/state.js";
import { runWeb, type WebCommandDeps } from "./web.js";

const DASHBOARD = "http://127.0.0.1:29193/ui/";

function fixture() {
  const events: string[] = [];
  const logs: string[] = [];
  const client = createDaemonClient(29193, "test-only");
  client.startCore = async () => {
    throw new Error("web must not start Core");
  };
  client.status = async () => {
    throw new Error("web must not depend on Core status");
  };
  const owner: HealthyDaemonSession = {
    kind: "daemon",
    daemon: { kind: "healthy", running: true, healthy: true, pid: 12345, port: 29193 },
    client,
  };
  const deps: WebCommandDeps = {
    runtimeContext: () => ({
      layout: sashLayout(path.join(os.tmpdir(), "sash-web-no-io")),
      settings: testSettings(),
    }),
    ensureDaemonSession: async () => {
      events.push("management");
      return owner;
    },
    openInBrowser: (url) => {
      events.push(`open ${url}`);
    },
    log: { info: (message) => logs.push(message), ok: (message) => logs.push(message) },
  };
  return { deps, events, logs };
}

test("web opens the dashboard address directly, independently of Core", async () => {
  const f = fixture();
  await runWeb({}, f.deps);
  assert.deepEqual(f.events, ["management", `open ${DASHBOARD}`]);
  assert.deepEqual(f.logs, ["Opening WebUI", DASHBOARD]);
});

test("--no-open starts management and prints the address without opening a browser", async () => {
  const f = fixture();
  await runWeb({ noOpen: true }, f.deps);
  assert.deepEqual(f.events, ["management"]);
  assert.deepEqual(f.logs, [DASHBOARD]);
});

test("management startup errors propagate without opening a browser", async () => {
  const f = fixture();
  f.deps.ensureDaemonSession = async () => {
    throw new Error("unverified owner");
  };
  await assert.rejects(runWeb({}, f.deps), /unverified owner/);
  assert.deepEqual(f.events, []);
});

test("opens a dashboard a fresh daemon serves and lets control", {
  timeout: 90_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-web-end-to-end-"));
  const layout = sashLayout(root);
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const settings = { ...testSettings(), daemonPort: port };
  createTestState(layout, settings);
  const opened: string[] = [];
  try {
    await runWeb(
      {},
      {
        runtimeContext: () => ({ layout, settings }),
        ensureDaemonSession,
        openInBrowser: (url) => {
          opened.push(url);
        },
      },
    );
    assert.deepEqual(opened, [`http://127.0.0.1:${port}/ui/`]);
    assert.equal((await evaluateDaemon(layout, settings)).kind, "healthy");
    const dispatcher = directDispatcherForLoopback();
    const page = await request(`http://127.0.0.1:${port}/sash/settings`, {
      headers: { "sec-fetch-site": "same-origin" },
      dispatcher,
    });
    assert.equal(page.statusCode, 200, "the opened page needs no credential");
    await page.body.dump();
    const foreign = await request(`http://127.0.0.1:${port}/sash/settings`, {
      headers: { "sec-fetch-site": "same-site" },
      dispatcher,
    });
    assert.equal(foreign.statusCode, 401);
    await foreign.body.dump();
    assert.equal(
      (await createDaemonClient(port, settings.daemonSecret).getSettings()).daemonPort,
      port,
    );
  } finally {
    await stopDaemonFromCli({ layout, settings, timeoutMs: 15_000 });
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});
