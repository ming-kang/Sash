import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SashDaemonClient } from "../daemon-client.js";
import { sashLayout } from "../paths.js";
import { writePidRecord } from "../process.js";
import { loadProfiles, profileFilePath } from "../profiles.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../settings.js";
import {
  ensureCore,
  type RuntimeContext,
  resolveRuntimeOwner,
  runOfflineMutation,
} from "./shared.js";

describe("offline mutation coordination", () => {
  let root: string;
  let ctx: RuntimeContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-offline-mutation-test-"));
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

  it("refreshes settings after taking the lock so concurrent fields are not lost", async () => {
    const newer = { ...loadSettings(ctx.layout), allowLan: true };
    saveSettings(newer, ctx.layout);

    await runOfflineMutation(ctx, "test merged settings", () => {
      assert.equal(ctx.settings.allowLan, true);
      ctx.settings.tun = true;
      saveSettings(ctx.settings, ctx.layout);
    });

    const persisted = loadSettings(ctx.layout);
    assert.equal(persisted.allowLan, true);
    assert.equal(persisted.tun, true);
  });

  it("recovers a profile journal after ownership verification before the action reads profiles", async () => {
    fs.mkdirSync(ctx.layout.profilesDir, { recursive: true });
    fs.mkdirSync(ctx.layout.stateDir, { recursive: true });
    const previous = '{"activeId":null,"profiles":[]}';
    fs.writeFileSync(ctx.layout.profilesIndexFile, '{"activeId":"123","profiles":[]}');
    fs.writeFileSync(
      ctx.layout.managedStateTransactionFile,
      JSON.stringify({
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        index: { data: Buffer.from(previous).toString("base64") },
      }),
    );

    await runOfflineMutation(ctx, "recover profile publication", () => {
      assert.deepEqual(loadProfiles(ctx.layout), { activeId: null, profiles: [] });
      assert.equal(fs.existsSync(ctx.layout.managedStateTransactionFile), false);
    });
  });

  it("imports unmanaged config before an offline action reads profile state", async () => {
    const unmanaged = "proxies:\n  - name: imported\n    type: direct\nrules:\n  - MATCH,DIRECT\n";
    fs.writeFileSync(ctx.layout.configFile, unmanaged);

    await runOfflineMutation(
      ctx,
      "import unmanaged config",
      () => {
        const index = loadProfiles(ctx.layout);
        assert.equal(index.profiles.length, 1);
        assert.equal(index.activeId, index.profiles[0]?.id);
        assert.equal(
          fs.readFileSync(profileFilePath(ctx.layout, index.profiles[0]?.id ?? ""), "utf8"),
          unmanaged,
        );
        assert.equal(fs.readFileSync(ctx.layout.configFile, "utf8"), unmanaged);
      },
      { migrateProfiles: true },
    );
  });

  it("does not let invalid unmanaged config block non-profile recovery mutations", async () => {
    fs.writeFileSync(ctx.layout.configFile, "proxies: [\n");
    let called = false;

    await runOfflineMutation(ctx, "proxy recovery", () => {
      called = true;
    });

    assert.equal(called, true);
    assert.equal(fs.existsSync(ctx.layout.profilesIndexFile), false);
  });

  it("fails closed when the Core PID record is corrupt", async () => {
    fs.mkdirSync(ctx.layout.stateDir, { recursive: true });
    fs.writeFileSync(ctx.layout.pidFile, "{ broken");

    await assert.rejects(
      runOfflineMutation(ctx, "unsafe corrupt-PID mutation", () => undefined),
      /Core PID record is corrupt/,
    );
  });

  it("ensureCore refuses to execute or replace an ambiguous binary", async () => {
    fs.mkdirSync(ctx.layout.binDir, { recursive: true });
    fs.writeFileSync(ctx.layout.coreExe, "ambiguous-core");

    await assert.rejects(() => ensureCore(ctx), /sash update --force/);
  });

  it("blocks ordinary mutations while an orphan Core PID is alive", async () => {
    writePidRecord(ctx.layout.pidFile, {
      pid: process.pid,
      exe: process.execPath,
      startedAt: new Date().toISOString(),
    });
    let called = false;

    await assert.rejects(
      runOfflineMutation(ctx, "unsafe mutation", () => {
        called = true;
      }),
      /Core PID .* is still alive without sashd/,
    );
    assert.equal(called, false);

    const recoveryEvents: string[] = [];
    await runOfflineMutation(
      ctx,
      "recovery mutation",
      () => {
        called = true;
      },
      {
        reconcileRuntime: {
          deps: {
            systemProxy: {
              release: async () => {
                recoveryEvents.push("proxy");
              },
            },
            supervisor: {
              cleanStaleCore: async () => {
                recoveryEvents.push("core");
              },
            },
            recoverCoreUpdate: () => {
              recoveryEvents.push("update");
              return undefined;
            },
          },
        },
      },
    );
    assert.equal(called, true);
    assert.deepEqual(recoveryEvents, ["proxy", "core", "update"]);
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
