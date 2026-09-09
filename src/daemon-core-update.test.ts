import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parseDaemonStatus } from "./contracts.js";
import { readInstallRecord } from "./core-install-record.js";
import { readCoreUpdateTransaction } from "./core-update.js";
import { parseCoreUpdateProgress } from "./core-update-progress.js";
import { useDaemonTestHarness } from "./daemon-test-harness.test.js";
import { deferred, FakeCoreSupervisor } from "./test-state.test.js";

describe("daemon-owned Core updates", () => {
  const h = useDaemonTestHarness();
  async function stage() {
    fs.mkdirSync(h.layout.tempDir, { recursive: true });
    const exe = path.join(h.layout.tempDir, "candidate");
    fs.writeFileSync(exe, "v2-core");
    return { exe, version: "v2", sha256: crypto.hash("sha256", "v2-core") };
  }
  it("publishes authenticated progress during preparation and clears it after completion", async () => {
    const entered = deferred();
    const released = deferred();
    await h.startServer({
      stageCore: async (options) => {
        options?.onStage?.("downloading", "v2");
        options?.onProgress?.(100, 200);
        entered.resolve();
        await released.promise;
        return stage();
      },
    });
    const saved = fs.readFileSync(h.layout.settingsFile);
    const updating = h.apiRequest("/sash/core/update", { method: "POST", body: { version: "v2" } });
    await entered.promise;
    try {
      assert.equal((await h.apiRequest("/sash/core/update", { token: "" })).statusCode, 401);
      const progress = parseCoreUpdateProgress((await h.apiRequest("/sash/core/update")).data);
      assert.equal(progress?.stage, "downloading");
      assert.equal(progress?.downloaded, 100);
      assert.equal(progress?.total, 200);
      assert.deepEqual(
        parseDaemonStatus((await h.apiRequest("/sash/daemon/status")).data).coreUpdate,
        progress,
      );
      assert.equal((await h.apiRequest("/sash/core/update", { method: "POST" })).statusCode, 409);
      assert.deepEqual(fs.readFileSync(h.layout.settingsFile), saved);
    } finally {
      released.resolve();
    }
    assert.equal((await updating).statusCode, 200);
    assert.equal((await h.apiRequest("/sash/core/update")).data, null);
  });

  it("does not let a cancelled download publish progress into its successor", async () => {
    const firstEntered = deferred();
    const firstReleased = deferred();
    const nextEntered = deferred();
    const nextReleased = deferred();
    let lateProgress: ((downloaded: number, total: number | undefined) => void) | undefined;
    let count = 0;
    await h.startServer({
      stageCore: async (options) => {
        count += 1;
        options?.onStage?.("downloading", "v2");
        if (count === 1) {
          lateProgress = options?.onProgress;
          firstEntered.resolve();
          await firstReleased.promise;
        } else {
          options?.onProgress?.(20, 200);
          nextEntered.resolve();
          await nextReleased.promise;
        }
        return stage();
      },
    });
    const first = h.apiRequest("/sash/core/update", { method: "POST" });
    await firstEntered.promise;
    await h.apiRequest("/sash/core/stop", { method: "POST" });
    firstReleased.resolve();
    assert.notEqual((await first).statusCode, 200);
    assert.equal((await h.apiRequest("/sash/core/update")).data, null);
    const next = h.apiRequest("/sash/core/update", { method: "POST" });
    await nextEntered.promise;
    try {
      lateProgress?.(199, 200);
      assert.equal(
        parseCoreUpdateProgress((await h.apiRequest("/sash/core/update")).data)?.downloaded,
        20,
      );
    } finally {
      nextReleased.resolve();
    }
    assert.equal((await next).statusCode, 200);
    assert.equal((await h.apiRequest("/sash/core/update")).data, null);
  });

  it("rejects modified installed bytes before config validation or Core execution", async () => {
    let validations = 0;
    await h.startServer({
      validateConfig: () => {
        validations += 1;
      },
    });
    fs.appendFileSync(h.layout.coreExe, "tampered");
    const result = await h.apiRequest("/sash/core/start", { method: "POST" });
    assert.equal(result.statusCode, 500);
    assert.match(JSON.stringify(result.data), /SHA-256 mismatch/);
    assert.equal(validations, 0);
    assert.equal(fs.existsSync(h.layout.configFile), false);
    assert.equal(
      parseDaemonStatus((await h.apiRequest("/sash/daemon/status")).data).core.running,
      false,
    );
  });
  for (const running of [false, true])
    it(`finishes validation without restarting daemon or invalidating sessions (running=${running})`, async () => {
      await h.startServer({ stageCore: stage });
      if (running) await h.apiRequest("/sash/core/start", { method: "POST" });
      const before = parseDaemonStatus((await h.apiRequest("/sash/daemon/status")).data);
      const token = await h.mintWebSession();
      const state = fs.readFileSync(h.layout.settingsFile, "utf8");
      const result = await h.apiRequest("/sash/core/update", {
        method: "POST",
        body: { version: "v2" },
      });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.data, { version: "v2" });
      const after = parseDaemonStatus((await h.apiRequest("/sash/daemon/status")).data);
      assert.equal(after.daemon.bootId, before.daemon.bootId);
      assert.equal(after.core.running, running);
      assert.equal(fs.readFileSync(h.layout.settingsFile, "utf8"), state);
      assert.equal(readCoreUpdateTransaction(h.layout), undefined);
      assert.equal(fs.existsSync(`${h.layout.coreExe}.bak`), false);
      assert.equal(
        (
          await h.apiRequest("/sash/settings", {
            method: "PATCH",
            webToken: token,
            body: { allowLan: true },
          })
        ).statusCode,
        200,
      );
    });
  it("restores the original running binary after failed candidate health", async () => {
    const core = new FakeCoreSupervisor(h.layout, h.settings);
    await h.startServer({ supervisor: core, stageCore: stage });
    await h.apiRequest("/sash/core/start", { method: "POST" });
    core.onStart = () => {
      if (readInstallRecord(h.layout)?.coreVersion === "v2") throw new Error("candidate failed");
    };
    assert.equal((await h.apiRequest("/sash/core/update", { method: "POST" })).statusCode, 500);
    assert.equal(readInstallRecord(h.layout)?.coreVersion, "v1.0.0");
    assert.equal(core.running, true);
    assert.equal(readCoreUpdateTransaction(h.layout), undefined);
  });
  it("cancels an uncommitted download when Core is stopped", async () => {
    const entered = deferred();
    const released = deferred();
    await h.startServer({
      stageCore: async () => {
        entered.resolve();
        await released.promise;
        return stage();
      },
    });
    const updating = h.apiRequest("/sash/core/update", { method: "POST" });
    await entered.promise;
    assert.equal((await h.apiRequest("/sash/daemon/health")).statusCode, 200);
    assert.equal((await h.apiRequest("/sash/core/stop", { method: "POST" })).statusCode, 204);
    released.resolve();
    assert.notEqual((await updating).statusCode, 200);
    assert.equal(readInstallRecord(h.layout)?.coreVersion, "v1.0.0");
    assert.equal(readCoreUpdateTransaction(h.layout), undefined);
  });
  it("blocks new Core mutations while an interrupted update still owns rollback files", async () => {
    await h.startServer({ stageCore: stage });
    fs.writeFileSync(
      h.layout.coreUpdateTransactionFile,
      JSON.stringify({
        version: 1,
        phase: "prepared",
        previous: readInstallRecord(h.layout),
        target: {
          coreVersion: "v2",
          installedAt: "2026-09-08T00:00:00.000Z",
          sha256: crypto.hash("sha256", "v2-core"),
        },
      }),
    );
    assert.equal((await h.apiRequest("/sash/core/restart", { method: "POST" })).statusCode, 409);
    assert.equal((await h.apiRequest("/sash/core/update", { method: "POST" })).statusCode, 409);
    assert.equal((await h.apiRequest("/sash/core/stop", { method: "POST" })).statusCode, 204);
    assert.equal(readCoreUpdateTransaction(h.layout)?.phase, "prepared");
  });
});
