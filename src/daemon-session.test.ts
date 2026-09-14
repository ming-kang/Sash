import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { RuntimeContext } from "./daemon-session.js";
import { resolveDaemonSession } from "./daemon-session.js";
import { sashLayout } from "./paths.js";
import { createDaemonClient } from "./sash-client-node.js";
import { createTestState, testSettings } from "./testing/state.js";

describe("resolveDaemonSession", () => {
  let root: string;
  let ctx: RuntimeContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-daemon-session-test-"));
    const layout = sashLayout(root);
    const settings = testSettings();
    createTestState(layout, settings);
    ctx = { layout, settings };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("constructs a daemon client from the observed healthy port", async () => {
    let clientPort: number | undefined;
    let clientSecret: string | undefined;
    const owner = await resolveDaemonSession(ctx, {
      evaluateDaemon: async () => ({
        kind: "healthy",
        running: true,
        healthy: true,
        pid: 1234,
        port: 23456,
      }),
      clientFactory: (port, secret) => {
        clientPort = port;
        clientSecret = secret;
        return createDaemonClient(port, secret);
      },
    });

    assert.equal(owner.kind, "daemon");
    assert.equal(clientPort, 23456);
    assert.equal(clientSecret, ctx.settings.daemonSecret);
    if (owner.kind === "daemon") assert.equal(owner.daemon.port, 23456);
  });

  it("returns tagged offline and unhealthy owners without creating clients", async () => {
    let clients = 0;
    const clientFactory = (port: number, secret: string) => {
      clients += 1;
      return createDaemonClient(port, secret);
    };
    const offline = await resolveDaemonSession(ctx, {
      evaluateDaemon: async () => ({ kind: "stopped", running: false, healthy: false }),
      clientFactory,
    });
    const unhealthy = await resolveDaemonSession(ctx, {
      evaluateDaemon: async () => ({
        kind: "unhealthy",
        running: true,
        healthy: false,
        pid: 4321,
        port: 34567,
      }),
      clientFactory,
    });

    assert.equal(offline.kind, "offline");
    assert.equal(unhealthy.kind, "unhealthy");
    assert.equal(clients, 0);
  });
});
