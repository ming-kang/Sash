import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { readInstallRecord, writeInstallRecord } from "./core-install-record.js";
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
    writeInstallRecord({ coreVersion: "v1", installedAt: "2026-01-01T00:00:00.000Z" }, layout);
  }
  function staged() {
    const exe = path.join(layout.binDir, "candidate");
    fs.writeFileSync(exe, "v2-core");
    return { exe, version: "v2" };
  }
  function verify(exe: string, version: string) {
    assert.equal(fs.readFileSync(exe, "utf8"), `${version}-core`, "binary version mismatch");
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
  function journal(phase: CoreUpdateTransaction["phase"]): CoreUpdateTransaction {
    return {
      version: 1,
      phase,
      previous: readInstallRecord(layout) ?? null,
      target: { coreVersion: "v2", installedAt: "2026-09-08T00:00:00.000Z" },
    };
  }
  function saveJournal(value: CoreUpdateTransaction) {
    fs.writeFileSync(layout.coreUpdateTransactionFile, JSON.stringify(value));
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
    assert.deepEqual(
      await commitCoreUpdate({ layout, staged: staged(), runtime: live, verifyExecutable: verify }),
      { version: "v2" },
    );
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
        verifyExecutable: verify,
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
      commitCoreUpdate({ layout, staged: staged(), runtime: live, verifyExecutable: verify }),
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
      commitCoreUpdate({ layout, staged: staged(), runtime: live, verifyExecutable: verify }),
      /rollback failed: candidate still running/,
    );
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
    assert.equal(fs.readFileSync(`${layout.coreExe}.bak`, "utf8"), "v1-core");
    assert.equal(readCoreUpdateTransaction(layout)?.phase, "swapped");
  });

  it("does not begin a replacement when safe stopping fails", async () => {
    seed();
    const live = runtime([]);
    live.stop = async () => {
      throw new Error("proxy restoration failed");
    };
    await assert.rejects(
      commitCoreUpdate({ layout, staged: staged(), runtime: live, verifyExecutable: verify }),
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
      commitCoreUpdate({ layout, staged: staged(), runtime: live, verifyExecutable: verify }),
      /bad candidate/,
    );
    assert.equal(fs.existsSync(layout.coreExe), false);
    assert.equal(fs.existsSync(layout.installFile), false);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  for (const point of [0, 1, 2, 3])
    it(`recovers an interrupted replacement at publication point ${point}`, () => {
      seed();
      const value = journal(point === 3 ? "swapped" : "prepared");
      saveJournal(value);
      if (point >= 1) fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
      if (point >= 2) fs.writeFileSync(layout.coreExe, "v2-core");
      if (point >= 3) writeInstallRecord(value.target, layout);
      recoverCoreUpdateTransaction(layout, verify);
      recoverCoreUpdateTransaction(layout, verify);
      assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
      assert.equal(readInstallRecord(layout)?.coreVersion, "v1");
      assert.equal(readCoreUpdateTransaction(layout), undefined);
    });

  it("finishes verified cleanup after a crash, including an already removed backup", () => {
    seed();
    const value = journal("verified");
    saveJournal(value);
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    fs.writeFileSync(layout.coreExe, "v2-core");
    writeInstallRecord(value.target, layout);
    fs.unlinkSync(`${layout.coreExe}.bak`);
    recoverCoreUpdateTransaction(layout, verify);
    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("retains a verified decision if cleanup fails instead of attempting an impossible rollback", async () => {
    seed();
    const unlink = fs.unlinkSync;
    mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
      if (String(file) === layout.coreUpdateTransactionFile)
        throw Object.assign(new Error("cleanup failed"), { code: "ENOSPC" });
      return unlink(file);
    });
    await assert.rejects(
      commitCoreUpdate({
        layout,
        staged: staged(),
        runtime: runtime([], false),
        verifyExecutable: verify,
      }),
      /cleanup failed/,
    );
    assert.equal(readCoreUpdateTransaction(layout)?.phase, "verified");
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
    mock.restoreAll();
    recoverCoreUpdateTransaction(layout, verify);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("fails closed on missing rollback ownership and invalid journals", () => {
    seed();
    const value = journal("swapped");
    saveJournal(value);
    fs.writeFileSync(layout.coreExe, "v2-core");
    assert.throws(() => recoverCoreUpdateTransaction(layout, verify), /mismatch/);
    assert.equal(readCoreUpdateTransaction(layout)?.phase, "swapped");
    for (const invalid of [
      "{bad",
      JSON.stringify({ ...value, phase: ["prepared"] }),
      JSON.stringify({ ...value, extra: true }),
      "x".repeat(16 * 1024 + 1),
    ]) {
      fs.writeFileSync(layout.coreUpdateTransactionFile, invalid);
      assert.throws(() => readCoreUpdateTransaction(layout));
      assert.equal(fs.readFileSync(layout.coreUpdateTransactionFile, "utf8"), invalid);
    }
    fs.unlinkSync(layout.coreUpdateTransactionFile);
    fs.writeFileSync(`${layout.coreExe}.bak`, "unknown");
    assert.throws(() => recoverCoreUpdateTransaction(layout, verify), /no ownership journal/);
    assert.equal(fs.readFileSync(`${layout.coreExe}.bak`, "utf8"), "unknown");
  });
});
