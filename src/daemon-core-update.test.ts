import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { DaemonStatus } from "./contracts.js";
import { readInstallRecord } from "./core.js";
import { type CoreUpdateProgress, readCoreUpdateTransaction } from "./core-update.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";
import { deferred, FakeCoreSupervisor } from "./testing/state.js";

/**
 * The transport decision reads this process environment, and the developer
 * machine may run with HTTP_PROXY pointed at Sash itself. Pin it empty for the
 * whole file so only the tests that set a variable see one.
 */
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];

describe("daemon-owned Core updates", () => {
  const h = useDaemonTestHarness();
  let savedProxyEnv: Array<[string, string | undefined]>;
  before(() => {
    savedProxyEnv = PROXY_ENV_KEYS.map((key) => [key, process.env[key]]);
    for (const key of PROXY_ENV_KEYS) delete process.env[key];
  });
  after(() => {
    for (const [key, value] of savedProxyEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  async function stage() {
    fs.mkdirSync(h.layout.tempDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(h.layout.tempDir, "candidate-"));
    const exe = path.join(dir, "candidate");
    fs.writeFileSync(exe, "v2-core");
    return { exe, dir, version: "v2", assetName: "mihomo-windows-amd64-v3-v2.zip" };
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
      const progress = (await h.apiRequest("/sash/core/update")).data as CoreUpdateProgress | null;
      assert.equal(progress?.stage, "downloading");
      assert.equal(progress?.downloaded, 100);
      assert.equal(progress?.total, 200);
      assert.deepEqual(
        ((await h.apiRequest("/sash/daemon/status")).data as DaemonStatus).coreUpdate,
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
        ((await h.apiRequest("/sash/core/update")).data as CoreUpdateProgress | null)?.downloaded,
        20,
      );
    } finally {
      nextReleased.resolve();
    }
    assert.equal((await next).statusCode, 200);
    assert.equal((await h.apiRequest("/sash/core/update")).data, null);
  });

  it("downloads nothing when the resolved release is already installed", async () => {
    let staged = 0;
    await h.startServer({
      resolveCoreRelease: async () => ({
        tag: "v1.0.0",
        assets: [],
        candidates: [],
        source: "live",
      }),
      stageCore: async () => {
        staged += 1;
        return stage();
      },
    });
    const result = await h.apiRequest("/sash/core/update", { method: "POST" });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.data, { version: "v1.0.0", alreadyCurrent: true });
    assert.equal(staged, 0);
    assert.equal(readInstallRecord(h.layout)?.coreVersion, "v1.0.0");
    assert.equal((await h.apiRequest("/sash/core/update")).data, null);
  });

  it("installs and starts a missing Core once with one configuration check", async () => {
    const core = new FakeCoreSupervisor(h.layout, h.settings);
    let validations = 0;
    await h.startServer({
      installCore: false,
      supervisor: core,
      stageCore: stage,
      validateConfig: () => {
        validations++;
      },
    });
    const response = await h.apiRequest("/sash/core/start", { method: "POST" });
    assert.equal(response.statusCode, 200);
    assert.equal((response.data as { alreadyRunning: boolean }).alreadyRunning, false);
    assert.equal(core.starts, 1);
    assert.equal(core.running, true);
    assert.equal(validations, 1);
    assert.equal(readInstallRecord(h.layout)?.coreVersion, "v2");
  });
  for (const running of [false, true])
    it(`finishes validation without restarting daemon or invalidating sessions (running=${running})`, async () => {
      await h.startServer({ stageCore: stage });
      if (running) await h.apiRequest("/sash/core/start", { method: "POST" });
      const before = (await h.apiRequest("/sash/daemon/status")).data as DaemonStatus;
      const token = await h.mintWebSession();
      const state = fs.readFileSync(h.layout.settingsFile, "utf8");
      const result = await h.apiRequest("/sash/core/update", {
        method: "POST",
        body: { version: "v2" },
      });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.data, { version: "v2" });
      const after = (await h.apiRequest("/sash/daemon/status")).data as DaemonStatus;
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
        },
      }),
    );
    assert.equal((await h.apiRequest("/sash/core/restart", { method: "POST" })).statusCode, 409);
    assert.equal((await h.apiRequest("/sash/core/update", { method: "POST" })).statusCode, 409);
    assert.equal((await h.apiRequest("/sash/core/stop", { method: "POST" })).statusCode, 204);
    assert.notEqual(readCoreUpdateTransaction(h.layout), undefined);
  });

  it("cancels an in-flight download on request and admits the next update immediately", async () => {
    const firstEntered = deferred();
    const firstReleased = deferred();
    const secondEntered = deferred();
    const secondReleased = deferred();
    let attempts = 0;
    await h.startServer({
      stageCore: async (options) => {
        attempts += 1;
        options?.onStage?.("downloading", "v2");
        options?.onProgress?.(100, 200);
        if (attempts === 1) {
          firstEntered.resolve();
          await firstReleased.promise;
        } else {
          secondEntered.resolve();
          await secondReleased.promise;
        }
        return stage();
      },
    });
    const first = h.apiRequest("/sash/core/update", { method: "POST", body: { version: "v2" } });
    await firstEntered.promise;
    assert.equal(
      ((await h.apiRequest("/sash/core/update")).data as CoreUpdateProgress | null)?.downloaded,
      100,
    );
    assert.equal((await h.apiRequest("/sash/core/update", { method: "DELETE" })).statusCode, 204);
    assert.equal((await h.apiRequest("/sash/core/update")).data, null);
    // The cancelled operation must not clear its successor's state as it unwinds.
    const second = h.apiRequest("/sash/core/update", { method: "POST", body: { version: "v2" } });
    await secondEntered.promise;
    firstReleased.resolve();
    assert.notEqual((await first).statusCode, 200);
    try {
      assert.equal(
        ((await h.apiRequest("/sash/core/update")).data as CoreUpdateProgress | null)?.downloaded,
        100,
      );
    } finally {
      secondReleased.resolve();
    }
    assert.equal((await second).statusCode, 200);
  });

  it("reports a conflict when no Core download is in progress", async () => {
    await h.startServer({ stageCore: stage });
    const response = await h.apiRequest("/sash/core/update", { method: "DELETE" });
    assert.equal(response.statusCode, 409);
    assert.match(JSON.stringify(response.data), /No Core download is in progress/);
  });

  it("names the cancel command when a download is already running", async () => {
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
    try {
      const conflict = await h.apiRequest("/sash/core/update", { method: "POST" });
      assert.equal(conflict.statusCode, 409);
      assert.match(JSON.stringify(conflict.data), /sash update --cancel/);
    } finally {
      released.resolve();
    }
    await updating;
  });

  it("prefers a running Core as the download transport and reports it in status", async () => {
    const core = new FakeCoreSupervisor(h.layout, h.settings);
    await h.startServer({ supervisor: core, stageCore: stage });
    await h.apiRequest("/sash/core/start", { method: "POST" });
    const running = (await h.apiRequest("/sash/daemon/status")).data as DaemonStatus;
    assert.deepEqual(running.downloadTransport, {
      uri: `http://127.0.0.1:${h.settings.mixedPort}`,
      source: "core",
    });
    await h.apiRequest("/sash/core/stop", { method: "POST" });
    const stopped = (await h.apiRequest("/sash/daemon/status")).data as DaemonStatus;
    assert.equal(stopped.downloadTransport, null);
  });

  it("keeps an explicit proxy environment variable as the download transport", async () => {
    const saved = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://127.0.0.1:9999";
    try {
      const core = new FakeCoreSupervisor(h.layout, h.settings);
      await h.startServer({ supervisor: core, stageCore: stage });
      await h.apiRequest("/sash/core/start", { method: "POST" });
      const status = (await h.apiRequest("/sash/daemon/status")).data as DaemonStatus;
      assert.deepEqual(status.downloadTransport, {
        uri: "http://127.0.0.1:9999",
        source: "environment",
      });
    } finally {
      if (saved === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = saved;
    }
  });

  it("passes the chosen transport into staging", async () => {
    const core = new FakeCoreSupervisor(h.layout, h.settings);
    const seen: Array<string | undefined> = [];
    await h.startServer({
      installCore: false,
      supervisor: core,
      resolveCoreRelease: async (options) => ({
        tag: options?.tag ?? "v2",
        assets: [],
        candidates: [],
        source: "live",
      }),
      stageCore: async (options) => {
        seen.push(options?.proxyUri);
        return stage();
      },
    });
    assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
    assert.deepEqual(seen, [undefined]);
    assert.equal(
      (await h.apiRequest("/sash/core/update", { method: "POST", body: { version: "v3" } }))
        .statusCode,
      200,
    );
    assert.deepEqual(seen, [undefined, `http://127.0.0.1:${h.settings.mixedPort}`]);
  });
});
