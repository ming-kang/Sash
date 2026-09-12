import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { readInstallRecord, writeInstallRecord } from "./core.js";
import {
  type CoreUpdateRuntime,
  type CoreUpdateTransaction,
  commitCoreUpdate,
  readCoreUpdateTransaction,
  recoverCoreUpdateTransaction,
} from "./core-update.js";
import { type SashLayout, sashLayout } from "./paths.js";

describe("Core binary transaction", () => {
  let root: string;
  let layout: SashLayout;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-core-update-test-"));
    layout = sashLayout(root);
    fs.mkdirSync(layout.binDir, { recursive: true });
    fs.mkdirSync(layout.stateDir, { recursive: true });
  });
  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function seed() {
    fs.writeFileSync(layout.coreExe, "v1-core");
    writeInstallRecord({ coreVersion: "v1" }, layout);
  }
  function staged() {
    const exe = path.join(layout.binDir, "candidate");
    fs.writeFileSync(exe, "v2-core");
    return { exe, version: "v2" };
  }
  function runtime(events: string[], wasRunning = true): CoreUpdateRuntime {
    return {
      wasRunning,
      stop: async () => {
        events.push("stop");
      },
      startAndVerify: async (version) => {
        events.push(`start:${version}`);
      },
      applySystemProxy: async () => {
        events.push("proxy");
      },
    };
  }
  function journal(): CoreUpdateTransaction {
    return {
      previous: readInstallRecord(layout) ?? null,
      target: { coreVersion: "v2" },
    };
  }
  function saveJournal(value: CoreUpdateTransaction) {
    fs.writeFileSync(layout.coreUpdateTransactionFile, JSON.stringify(value));
  }

  for (const slot of ["current", "staged"]) {
    it(`rejects an empty ${slot} file before changing the runtime`, async () => {
      seed();
      const candidate = staged();
      const file = slot === "current" ? layout.coreExe : candidate.exe;
      fs.writeFileSync(file, "");
      const metadata = fs.readFileSync(layout.installFile, "utf8");
      const events: string[] = [];
      await assert.rejects(
        commitCoreUpdate({
          layout,
          staged: candidate,
          runtime: runtime(events),
        }),
        /nonempty regular file/,
      );
      assert.deepEqual(events, []);
      assert.equal(fs.readFileSync(layout.installFile, "utf8"), metadata);
      assert.equal(fs.existsSync(layout.coreUpdateTransactionFile), false);
      assert.equal(fs.readFileSync(file, "utf8"), "");
    });
  }

  it("retains .bak through health and proxy restoration, then commits", async () => {
    seed();
    const events: string[] = [];
    const live = runtime(events);
    live.startAndVerify = async (version) => {
      events.push(`start:${version}`);
      assert.equal(fs.existsSync(`${layout.coreExe}.bak`), true);
    };
    live.applySystemProxy = async () => {
      events.push("proxy");
      assert.equal(fs.existsSync(`${layout.coreExe}.bak`), true);
    };
    assert.deepEqual(await commitCoreUpdate({ layout, staged: staged(), runtime: live }), {
      version: "v2",
    });
    assert.deepEqual(events, ["stop", "start:v2", "proxy"]);
    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
  });

  for (const installed of [false, true])
    it(`validates a stopped install now and leaves it stopped (installed=${installed})`, async () => {
      if (installed) seed();
      const events: string[] = [];
      await commitCoreUpdate({
        layout,
        staged: staged(),
        runtime: runtime(events, false),
      });
      assert.deepEqual(events, ["stop", "start:v2", "stop"]);
      assert.equal(readCoreUpdateTransaction(layout), undefined);
      assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
    });

  it("restores exact binary, metadata and running state after failed health", async () => {
    seed();
    const previous = fs.readFileSync(layout.installFile, "utf8");
    const events: string[] = [];
    const live = runtime(events);
    const failure = new TypeError("candidate unhealthy");
    live.startAndVerify = async (version) => {
      events.push(`start:${version}`);
      if (version === "v2") throw failure;
    };
    await assert.rejects(
      commitCoreUpdate({ layout, staged: staged(), runtime: live }),
      (error) => error === failure,
    );
    assert.deepEqual(events, ["stop", "start:v2", "stop", "start:v1", "proxy"]);
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(fs.readFileSync(layout.installFile, "utf8"), previous);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("keeps both binaries and the journal when candidate termination is unverified", async () => {
    seed();
    let stops = 0;
    const live = runtime([]);
    live.stop = async () => {
      if (++stops > 1) throw new Error("candidate still running");
    };
    live.startAndVerify = async () => {
      throw new Error("unhealthy");
    };
    await assert.rejects(
      commitCoreUpdate({ layout, staged: staged(), runtime: live }),
      /rollback failed: candidate still running/,
    );
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
    assert.equal(fs.readFileSync(`${layout.coreExe}.bak`, "utf8"), "v1-core");
    assert.notEqual(readCoreUpdateTransaction(layout), undefined);
  });

  it("does not begin a replacement when safe stopping fails", async () => {
    seed();
    const live = runtime([]);
    live.stop = async () => {
      throw new Error("proxy restoration failed");
    };
    await assert.rejects(
      commitCoreUpdate({ layout, staged: staged(), runtime: live }),
      /proxy restoration failed/,
    );
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("rolls back a failed first install without retaining an unverified executable", async () => {
    const live = runtime([], false);
    live.startAndVerify = async () => {
      throw new Error("bad candidate");
    };
    await assert.rejects(
      commitCoreUpdate({ layout, staged: staged(), runtime: live }),
      /bad candidate/,
    );
    assert.equal(fs.existsSync(layout.coreExe), false);
    assert.equal(fs.existsSync(layout.installFile), false);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  for (const point of [0, 1, 2, 3])
    it(`recovers an interrupted replacement at publication point ${point}`, () => {
      seed();
      const value = journal();
      saveJournal(value);
      if (point >= 1) fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
      if (point >= 2) fs.writeFileSync(layout.coreExe, "v2-core");
      if (point >= 3) writeInstallRecord(value.target, layout);
      recoverCoreUpdateTransaction(layout);
      recoverCoreUpdateTransaction(layout);
      assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
      assert.equal(readInstallRecord(layout)?.coreVersion, "v1");
      assert.equal(readCoreUpdateTransaction(layout), undefined);
    });

  it("finishes verified cleanup after a crash, including an already removed backup", () => {
    seed();
    const value: CoreUpdateTransaction = { ...journal(), verified: true };
    saveJournal(value);
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    fs.writeFileSync(layout.coreExe, "v2-core");
    writeInstallRecord(value.target, layout);
    fs.unlinkSync(`${layout.coreExe}.bak`);
    recoverCoreUpdateTransaction(layout);
    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("tolerates a legacy phase journal from the previous format", () => {
    seed();
    const legacy = {
      version: 1,
      phase: "verified",
      previous: { coreVersion: "v1" },
      target: { coreVersion: "v2" },
    };
    fs.writeFileSync(layout.coreUpdateTransactionFile, JSON.stringify(legacy));
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    fs.writeFileSync(layout.coreExe, "v2-core");
    writeInstallRecord({ coreVersion: "v2" }, layout);
    recoverCoreUpdateTransaction(layout);
    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("finishes rollback after the old binary was renamed back but metadata is still new", () => {
    seed();
    const value = journal();
    writeInstallRecord(value.target, layout);
    saveJournal(value);
    recoverCoreUpdateTransaction(layout);
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(readInstallRecord(layout)?.coreVersion, "v1");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("reports success and retains cleanup work when deleting the journal fails", async () => {
    seed();
    const unlink = fs.unlinkSync;
    mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
      if (String(file) === layout.coreUpdateTransactionFile)
        throw Object.assign(new Error("cleanup failed"), { code: "ENOSPC" });
      return unlink(file);
    });
    assert.deepEqual(
      await commitCoreUpdate({
        layout,
        staged: staged(),
        runtime: runtime([], false),
      }),
      { version: "v2" },
    );
    assert.equal(readCoreUpdateTransaction(layout)?.verified, true);
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
    mock.restoreAll();
    recoverCoreUpdateTransaction(layout);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("reads a damaged journal as absent and refuses an orphaned backup", () => {
    seed();
    const value = journal();
    for (const invalid of [
      "{bad",
      JSON.stringify({ ...value, previous: 42 }),
      JSON.stringify({ ...value, target: { coreVersion: "!" } }),
      "x".repeat(16 * 1024 + 1),
    ]) {
      fs.writeFileSync(layout.coreUpdateTransactionFile, invalid);
      assert.equal(readCoreUpdateTransaction(layout), undefined);
      assert.equal(fs.readFileSync(layout.coreUpdateTransactionFile, "utf8"), invalid);
    }
    fs.unlinkSync(layout.coreUpdateTransactionFile);
    fs.writeFileSync(`${layout.coreExe}.bak`, "unknown");
    assert.throws(() => recoverCoreUpdateTransaction(layout), /no ownership journal/);
    assert.equal(fs.readFileSync(`${layout.coreExe}.bak`, "utf8"), "unknown");
  });
});
