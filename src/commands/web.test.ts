import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDaemonClient } from "../daemon-client.js";
import { sashLayout } from "../paths.js";
import type { HealthyRuntimeOwner } from "../runtime-owner.js";
import { testSettings } from "../testing/state.js";
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
  const owner: HealthyRuntimeOwner = {
    kind: "daemon",
    daemon: { kind: "healthy", running: true, healthy: true, pid: 12345, port: 29193 },
    client,
  };
  const deps: WebCommandDeps = {
    runtimeContext: () => ({
      layout: sashLayout(path.join(os.tmpdir(), "sash-web-no-io")),
      settings: testSettings(),
    }),
    ensureManagement: async () => {
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
  assert.deepEqual(f.logs, ["dashboard: http://127.0.0.1:29193/ui/"]);
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
  f.deps.ensureManagement = async () => {
    throw new Error("unverified owner");
  };
  await assert.rejects(runWeb({}, f.deps), /unverified owner/);
  assert.deepEqual(f.events, []);
});
