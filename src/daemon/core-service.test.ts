import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DaemonStatus, ProfileActionResponse } from "../contracts.js";
import { readInstallRecord } from "../core.js";
import { readCoreUpdateTransaction } from "../core-update.js";
import { useDaemonTestHarness } from "../testing/daemon-harness.js";
import { deferred, FakeCoreSupervisor } from "../testing/state.js";

const SOURCE = "proxies: [{name: one, type: direct}]\nrules: [MATCH,DIRECT]\n";

describe("Core configuration preparation ownership", () => {
  const h = useDaemonTestHarness();
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.SASH_HOME;
    process.env.SASH_HOME = h.layout.root;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.SASH_HOME;
    else process.env.SASH_HOME = previousHome;
  });

  async function importProfile(name: string) {
    const response = await h.apiRequest("/sash/profiles/import", {
      method: "POST",
      body: { name, content: SOURCE },
    });
    assert.equal(response.statusCode, 200);
    return response.data as ProfileActionResponse;
  }

  async function status(): Promise<DaemonStatus> {
    const response = await h.apiRequest("/sash/daemon/status");
    assert.equal(response.statusCode, 200);
    return response.data as DaemonStatus;
  }

  function stagedDownload() {
    const entered = deferred();
    const release = deferred();
    return {
      entered,
      release,
      stageCore: async () => {
        entered.resolve();
        await release.promise;
        fs.mkdirSync(h.layout.tempDir, { recursive: true });
        const dir = fs.mkdtempSync(path.join(h.layout.tempDir, "core-staged-"));
        const exe = path.join(dir, "candidate");
        fs.writeFileSync(exe, "v2-core");
        return { exe, dir, version: "v2" };
      },
    };
  }

  for (const running of [false, true]) {
    it(`allows unrelated rename and reorder during an update (running=${running})`, async () => {
      const download = stagedDownload();
      await h.startServer({ stageCore: download.stageCore });
      const active = await importProfile("active");
      const inactive = await importProfile("inactive");
      if (running)
        assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
      const before = await status();
      const applied = h.instance?.lifecycle.configuration();
      const updating = h.apiRequest("/sash/core/update", { method: "POST" });
      await download.entered.promise;
      try {
        assert.equal(
          (
            await h.apiRequest(`/sash/profiles/${inactive.profile.id}`, {
              method: "PATCH",
              body: { name: "renamed" },
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await h.apiRequest("/sash/profiles/order", {
              method: "PUT",
              body: { ids: [inactive.profile.id, active.profile.id] },
            })
          ).statusCode,
          200,
        );
        const edited = await status();
        assert.ok(edited.revisions.state > before.revisions.state);
        assert.equal(edited.revisions.runtime, before.revisions.runtime);
        download.release.resolve();
        assert.equal((await updating).statusCode, 200);
        const after = await status();
        assert.equal(after.revisions.state, edited.revisions.state);
        assert.equal(after.core.running, running);
        assert.equal(after.configuration.pending, false);
        assert.equal(readInstallRecord(h.layout)?.coreVersion, "v2");
        if (applied)
          assert.deepEqual(h.instance?.lifecycle.configuration()?.generated, applied.generated);
      } finally {
        download.release.resolve();
        await updating;
      }
    });

    for (const change of ["profile", "listeners"] as const) {
      it(`uses the actual configuration dependency during an update (running=${running}, change=${change})`, async () => {
        const download = stagedDownload();
        const core = new FakeCoreSupervisor(h.layout, h.settings);
        await h.startServer({ supervisor: core, stageCore: download.stageCore });
        const active = await importProfile("active");
        if (running)
          assert.equal(
            (await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode,
            200,
          );
        const before = await status();
        const applied = h.instance?.lifecycle.configuration();
        const updating = h.apiRequest("/sash/core/update", { method: "POST" });
        await download.entered.promise;
        try {
          const saved =
            change === "profile"
              ? await h.apiRequest(`/sash/profiles/${active.profile.id}/content`, {
                  method: "PUT",
                  body: {
                    revision: active.profile.revision,
                    content: SOURCE.replace("one", "two"),
                  },
                })
              : await h.apiRequest("/sash/settings", {
                  method: "PATCH",
                  body: { mixedPort: h.settings.mixedPort + 100, allowLan: true },
                });
          assert.equal(saved.statusCode, 200);
          const edited = await status();
          assert.equal(edited.revisions.runtime, before.revisions.runtime);
          download.release.resolve();
          assert.equal((await updating).statusCode, running ? 200 : 409);
          const after = await status();
          assert.equal(after.revisions.state, edited.revisions.state);
          assert.equal(after.configuration.pending, true);
          assert.equal(readCoreUpdateTransaction(h.layout), undefined);
          assert.equal(readInstallRecord(h.layout)?.coreVersion, running ? "v2" : "v1.0.0");
          if (applied) {
            assert.deepEqual(h.instance?.lifecycle.configuration()?.generated, applied.generated);
            assert.equal(fs.readFileSync(h.layout.configFile, "utf8"), applied.generated.yaml);
          } else {
            assert.equal(core.starts, 0);
            assert.equal(fs.existsSync(h.layout.configFile), false);
            assert.equal(after.revisions.runtime, before.revisions.runtime);
          }
        } finally {
          download.release.resolve();
          await updating;
        }
      });
    }
  }

  it("retains the runtime epoch conflict when another Apply finishes during download", async () => {
    const download = stagedDownload();
    await h.startMockCore((req, res) => {
      req.resume();
      res.writeHead(204);
      res.end();
    });
    await h.startServer({ stageCore: download.stageCore });
    assert.equal((await h.apiRequest("/sash/core/start", { method: "POST" })).statusCode, 200);
    const before = await status();
    const updating = h.apiRequest("/sash/core/update", { method: "POST" });
    await download.entered.promise;
    try {
      assert.equal((await h.apiRequest("/sash/core/restart", { method: "POST" })).statusCode, 200);
      const applied = await status();
      assert.equal(applied.revisions.state, before.revisions.state);
      assert.ok(applied.revisions.runtime > before.revisions.runtime);
      download.release.resolve();
      const rejected = await updating;
      assert.equal(rejected.statusCode, 409);
      assert.match(JSON.stringify(rejected.data), /Core changed during download/);
      assert.equal(readInstallRecord(h.layout)?.coreVersion, "v1.0.0");
      assert.equal(readCoreUpdateTransaction(h.layout), undefined);
    } finally {
      download.release.resolve();
      await updating;
    }
  });
});
