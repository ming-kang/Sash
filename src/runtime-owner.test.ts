import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SashDaemonClient } from "./daemon-client.js";
import type { RuntimeContext } from "./offline-mutation.js";
import { sashLayout } from "./paths.js";
import { resolveRuntimeOwner } from "./runtime-owner.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings.js";

describe("resolveRuntimeOwner", () => {
  let root: string;
  let ctx: RuntimeContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-runtime-owner-test-"));
    const layout = sashLayout(root);
    const settings = {
      ...DEFAULT_SETTINGS,
      secret: "core-secret",
      daemonSecret: "daemon-secret",
    };
    saveSettings(settings, layout);
    ctx = { layout, settings: loadSettings(layout) };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("constructs a daemon client from the observed healthy port", async () => {
    let clientPort: number | undefined;
    let clientSecret: string | undefined;
    const owner = await resolveRuntimeOwner(ctx, {
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
        return new SashDaemonClient(port, secret);
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
      return new SashDaemonClient(port, secret);
    };
    const offline = await resolveRuntimeOwner(ctx, {
      evaluateDaemon: async () => ({ kind: "stopped", running: false, healthy: false }),
      clientFactory,
    });
    const unhealthy = await resolveRuntimeOwner(ctx, {
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
