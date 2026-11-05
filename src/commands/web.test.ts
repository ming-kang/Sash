import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateDaemon, stopDaemonFromCli } from "../daemon-lifecycle.js";
import { ensureDaemonSession, type HealthyDaemonSession } from "../daemon-session.js";
import { sashLayout } from "../paths.js";
import { createDaemonClient } from "../sash-client-node.js";
import { createTestState, testSettings } from "../testing/state.js";
import { runWeb, type WebCommandDeps } from "./web.js";

const TOKEN = "b".repeat(64);
const FILE_URL = "file:///nonexistent/web-bootstrap-test.html";

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
  client.createWebBootstrap = async () => ({
    token: TOKEN,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
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
    writeBootstrap: (_layout, options) => {
      assert.equal(options.token, TOKEN);
      assert.equal(options.dashboardUrl, "http://127.0.0.1:29193/ui/");
      events.push("bootstrap");
      return { filePath: "/nonexistent/web-bootstrap-test.html", fileUrl: FILE_URL };
    },
    log: { info: (message) => logs.push(message), ok: (message) => logs.push(message) },
  };
  return { deps, client, events, logs };
}

test("web opens management independently of Core through a private credential handoff", async () => {
  const f = fixture();
  await runWeb({}, f.deps);
  assert.deepEqual(f.events, ["management", "bootstrap", `open ${FILE_URL}`]);
  assert.deepEqual(f.logs, ["Opening WebUI", "http://127.0.0.1:29193/ui/"]);
  assert.ok([...f.events, ...f.logs].every((line) => !line.includes(TOKEN)));
});

test("--no-open starts management without minting credentials or opening a browser", async () => {
  const f = fixture();
  f.client.createWebBootstrap = async () => {
    throw new Error("unexpected credential");
  };
  await runWeb({ noOpen: true }, f.deps);
  assert.deepEqual(f.events, ["management"]);
  assert.ok(f.logs.some((line) => line.includes("sash web")));
});

test("failed authorization never opens a browser", async () => {
  const f = fixture();
  f.client.createWebBootstrap = async () => {
    throw new Error("CLI credential rejected");
  };
  await assert.rejects(runWeb({}, f.deps), /CLI credential rejected/);
  assert.deepEqual(f.events, ["management"]);
  assert.deepEqual(f.logs, []);
});

test("management startup errors propagate without opening a browser", async () => {
  const f = fixture();
  f.deps.ensureDaemonSession = async () => {
    throw new Error("unverified owner");
  };
  await assert.rejects(runWeb({}, f.deps), /unverified owner/);
  assert.deepEqual(f.events, []);
});

test("authorizes a browser end to end against a freshly spawned daemon", {
  timeout: 90_000,
}, async () => {
  // The real chain: ensureDaemonSession starts a new daemon process, the CLI
  // writes the handoff file from the daemon's clock-stamped grant, and the
  // live daemon redeems it. A daemon process can read its wall clock a few
  // milliseconds ahead of the CLI, which used to fail this flow before the
  // handoff was ever written.
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
    assert.equal(opened.length, 1);
    const handoffPath = fileURLToPath(opened[0] as string);
    assert.ok(fs.existsSync(handoffPath));
    assert.equal((await evaluateDaemon(layout, settings)).kind, "healthy");
    const token = /"token":"([a-f0-9]{64})"/.exec(fs.readFileSync(handoffPath, "utf8"))?.[1];
    assert.ok(token);
    const session = await createDaemonClient(port, settings.daemonSecret).redeemWebBootstrap(token);
    assert.match(session.token, /^[a-f0-9]{64}$/);
  } finally {
    await stopDaemonFromCli({ layout, settings, timeoutMs: 15_000 });
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});
