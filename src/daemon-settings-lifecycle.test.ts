import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { readState } from "./app-state.js";
import { parseDaemonStatus, parseSettingsWriteResult } from "./contracts.js";
import { useDaemonTestHarness } from "./daemon-test-harness.test.js";
import { deferred, FakeCoreSupervisor } from "./test-state.test.js";

describe("save and apply API", () => {
  const h = useDaemonTestHarness();
  async function status() {
    return parseDaemonStatus((await h.apiRequest("/sash/daemon/status")).data);
  }
  it("allows only one of two concurrent settings writes based on the same state revision", async () => {
    await h.startServer();
    const before = await status();
    const results = await Promise.all(
      [18888, 19999].map((mixedPort) =>
        h.apiRequest("/sash/settings", {
          method: "PATCH",
          body: { mixedPort, expectedRevision: before.revisions.state },
        }),
      ),
    );
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
    const winner = results.find((result) => result.statusCode === 200);
    assert.ok(winner);
    const saved = parseSettingsWriteResult(winner.data);
    const after = await status();
    assert.equal(saved.revision, before.revisions.state + 1);
    assert.equal(after.revisions.state, saved.revision);
    assert.equal(after.settings.mixedPort, saved.settings.mixedPort);
    assert.equal(after.core.running, false);
    assert.equal(fs.existsSync(h.layout.configFile), false);
  });
  it("keeps saved settings consistent with the returned revision during a slow status probe", async () => {
    const entered = deferred();
    const release = deferred();
    const core = new FakeCoreSupervisor(h.layout, h.settings);
    await h.startServer({ supervisor: core });
    core.onStatus = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = status();
    await entered.promise;
    const write = await h.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { mixedPort: 18888, expectedRevision: 0 },
    });
    assert.equal(write.statusCode, 200);
    release.resolve();
    const observed = await pending;
    assert.equal(observed.settings.mixedPort, 18888);
    assert.equal(observed.revisions.state, parseSettingsWriteResult(write.data).revision);
  });
  it("serves management with no installed Core and rejects retired controls", async () => {
    await h.startServer({ installCore: false });
    assert.equal((await h.apiRequest("/sash/daemon/health")).statusCode, 200);
    assert.equal((await status()).core.running, false);
    assert.equal(fs.existsSync(h.layout.coreExe), false);
    assert.equal((await h.apiRequest("/sash/settings/file")).statusCode, 404);
    for (const body of [
      { tun: false },
      { daemonPort: 18000 },
      { daemonSecret: "new" },
      { controller: "remote:80" },
    ]) {
      assert.equal(
        (await h.apiRequest("/sash/settings", { method: "PATCH", body })).statusCode,
        400,
      );
    }
  });
  it("saves preferences without replacing the running Core, then applies once", async () => {
    const core = new FakeCoreSupervisor(h.layout, h.settings);
    await h.startServer({ supervisor: core });
    await h.apiRequest("/sash/core/start", { method: "POST" });
    const starts = core.starts;
    await h.apiRequest("/sash/settings", {
      method: "PATCH",
      body: { mixedPort: 18888, allowLan: true },
    });
    const saved = await status();
    assert.equal(core.starts, starts);
    assert.equal(saved.settings.mixedPort, 18888);
    assert.equal(saved.configuration.appliedSettings?.mixedPort, h.settings.mixedPort);
    assert.equal(saved.configuration.pending, true);
    await h.apiRequest("/sash/core/restart", { method: "POST" });
    assert.equal(core.starts, starts + 1);
    assert.equal((await status()).configuration.pending, false);
    assert.equal((await status()).configuration.appliedSettings?.mixedPort, 18888);
  });
  it("keeps old Core running on validation failure and preserves the saved edit", async () => {
    await h.startServer({
      validateConfig: (generated) => {
        if (generated.yaml.includes("18888")) throw new Error("invalid config");
      },
    });
    await h.apiRequest("/sash/core/start", { method: "POST" });
    const before = await status();
    const oldConfig = fs.readFileSync(h.layout.configFile, "utf8");
    await h.apiRequest("/sash/settings", { method: "PATCH", body: { mixedPort: 18888 } });
    assert.equal((await h.apiRequest("/sash/core/restart", { method: "POST" })).statusCode, 500);
    assert.equal((await status()).core.pid, before.core.pid);
    assert.equal((await status()).core.running, true);
    assert.equal(readState(h.layout)?.settings.mixedPort, 18888);
    assert.equal(fs.readFileSync(h.layout.configFile, "utf8"), oldConfig);
  });
  it("keeps management and saved settings available when candidate startup fails", async () => {
    const core = new FakeCoreSupervisor(h.layout, h.settings);
    await h.startServer({ supervisor: core });
    await h.apiRequest("/sash/core/start", { method: "POST" });
    await h.apiRequest("/sash/settings", { method: "PATCH", body: { allowLan: true } });
    core.onStart = () => {
      throw new Error("startup failed");
    };
    assert.equal((await h.apiRequest("/sash/core/restart", { method: "POST" })).statusCode, 500);
    const failed = await status();
    assert.equal(failed.core.running, false);
    assert.equal(failed.settings.allowLan, true);
    assert.equal(failed.configuration.pending, true);
  });
  it("keeps health responsive while Apply validates and serializes later settings writes", async () => {
    const entered = deferred();
    const release = deferred();
    await h.startServer({
      validateConfig: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const applying = h.apiRequest("/sash/core/start", { method: "POST" });
    await entered.promise;
    const saved = h.apiRequest("/sash/settings", { method: "PATCH", body: { allowLan: true } });
    assert.equal((await h.apiRequest("/sash/daemon/health")).statusCode, 200);
    release.resolve();
    assert.equal((await applying).statusCode, 200);
    assert.equal((await saved).statusCode, 200);
    assert.equal((await status()).configuration.pending, true);
  });

  it("cancels pending validation before stopping Core", async () => {
    const entered = deferred();
    const core = new FakeCoreSupervisor(h.layout, h.settings);
    await h.startServer({
      supervisor: core,
      validateConfig: async (_generated, _exe, signal) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    });
    const applying = h.apiRequest("/sash/core/start", { method: "POST" });
    await entered.promise;
    assert.equal((await h.apiRequest("/sash/core/stop", { method: "POST" })).statusCode, 204);
    assert.equal((await applying).statusCode, 409);
    assert.equal(core.starts, 0);
    assert.equal(core.running, false);
  });

  it("applies saved configuration when start was queued behind stop", async () => {
    const entered = deferred();
    const release = deferred();
    const core = new FakeCoreSupervisor(h.layout, h.settings);
    await h.startServer({ supervisor: core });
    await h.apiRequest("/sash/core/start", { method: "POST" });
    await h.apiRequest("/sash/settings", { method: "PATCH", body: { mixedPort: 18888 } });
    core.onStop = async () => {
      entered.resolve();
      await release.promise;
    };
    const stopping = h.apiRequest("/sash/core/stop", { method: "POST" });
    await entered.promise;
    const starting = h.apiRequest("/sash/core/start", { method: "POST" });
    release.resolve();
    assert.equal((await stopping).statusCode, 204);
    assert.equal((await starting).statusCode, 200);
    assert.equal((await status()).configuration.appliedSettings?.mixedPort, 18888);
    assert.equal((await status()).configuration.pending, false);
  });
});
