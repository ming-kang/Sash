import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { readState } from "./app-state.js";
import { parseSettingsPatch } from "./contracts.js";
import { DaemonGate } from "./daemon/context.js";
import { sashLayout } from "./paths.js";
import { RuntimeLifecycle } from "./runtime-lifecycle.js";
import { SettingsService } from "./settings-service.js";
import type { SystemProxyController } from "./system-proxy-manager.js";
import { createTestState, FakeCoreSupervisor, testSettings } from "./test-state.test.js";

describe("saved settings", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-settings-service-test-"));
  });
  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function fixture(systemProxy = false) {
    const layout = sashLayout(root);
    const state = createTestState(layout, testSettings({ systemProxy }));
    const core = new FakeCoreSupervisor(layout);
    let releases = 0;
    let applies = 0;
    const proxy: SystemProxyController = {
      apply: async () => {
        applies += 1;
      },
      release: async () => {
        releases += 1;
      },
      inspect: async () => ({
        applied: false,
        appliedKnown: true,
        stateKnown: true,
        state: { supported: true, enabled: false },
      }),
      isApplied: async () => false,
      getState: async () => ({ supported: true, enabled: false }),
    };
    const lifecycle = new RuntimeLifecycle({
      layout,
      supervisor: core,
      systemProxy: proxy,
      settings: () => state.snapshot().settings,
      controllerProbe: async () => false,
    });
    const gate = new DaemonGate(
      async () => {},
      () => {},
    );
    const service = new SettingsService({
      state,
      supervisor: core,
      lifecycle,
      commit: (purpose, action) => gate.mutate(purpose, action),
    });
    return {
      layout,
      state,
      core,
      proxy,
      lifecycle,
      service,
      releases: () => releases,
      applies: () => applies,
    };
  }
  it("saves network preferences in one commit without restarting or rendering Core", async () => {
    const f = fixture();
    const oldPort = f.lifecycle.settings().mixedPort;
    const result = await f.service.apply({ mixedPort: 18888, allowLan: true });
    assert.equal(result.restartRequired, true);
    assert.equal(f.state.snapshot().revision, 1);
    assert.equal(readState(f.layout)?.settings.mixedPort, 18888);
    assert.equal(f.lifecycle.settings().mixedPort, oldPort);
    assert.equal(f.core.starts, 0);
    assert.equal(fs.existsSync(f.layout.configFile), false);
  });
  it("rejects invalid settings and proxy enable without a healthy Core", async () => {
    const f = fixture();
    await assert.rejects(f.service.apply({ mixedPort: 0 }));
    await assert.rejects(f.service.apply({ systemProxy: true }), /not healthy/);
    assert.equal(f.state.snapshot().revision, 0);
    assert.equal(f.state.snapshot().settings.systemProxy, false);
    for (const field of ["controller", "secret", "daemonPort", "daemonSecret", "tun"])
      assert.throws(() => parseSettingsPatch({ [field]: true }), /Unknown/);
  });
  it("persists proxy off before OS cleanup and allows an explicit retry", async () => {
    const f = fixture(true);
    let attempts = 0;
    f.proxy.release = async () => {
      assert.equal(readState(f.layout)?.settings.systemProxy, false);
      if (++attempts === 1) throw new Error("restore failed");
    };
    await assert.rejects(f.service.apply({ systemProxy: false }), /restore failed/);
    await f.service.apply({ systemProxy: false });
    assert.equal(attempts, 2);
  });
  it("does not change OS state when durable preference publication fails", async () => {
    const f = fixture(true);
    const rename = fs.renameSync;
    mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === f.layout.settingsFile)
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return rename(from, to);
    });
    await assert.rejects(f.service.apply({ systemProxy: false }), /disk full/);
    assert.equal(f.releases(), 0);
    assert.equal(f.state.snapshot().settings.systemProxy, true);
  });
  it("keeps an explicit desired state observable after an OS apply failure", async () => {
    const f = fixture();
    f.core.running = true;
    f.proxy.apply = async () => {
      throw new Error("OS rejected proxy");
    };
    await assert.rejects(f.service.apply({ systemProxy: true }), /OS rejected proxy/);
    assert.equal(readState(f.layout)?.settings.systemProxy, true);
    assert.equal(f.core.running, true);
  });
  it("can retry an already-saved proxy-off intent without another disk write", async () => {
    const f = fixture();
    mock.method(fs, "renameSync", () => {
      throw new Error("unexpected state write");
    });
    await f.service.apply({ systemProxy: false });
    assert.equal(f.releases(), 1);
    assert.equal(f.state.snapshot().revision, 0);
  });
});
