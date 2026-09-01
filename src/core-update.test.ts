import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readInstallRecord, writeInstallRecord } from "./core.js";
import {
  type CoreUpdateRuntime,
  commitCoreUpdate,
  recoverInterruptedCoreUpdate,
} from "./core-update.js";
import { type SashLayout, sashLayout } from "./paths.js";

describe("core update transaction", () => {
  let tmpDir: string;
  let layout: SashLayout;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-core-update-test-"));
    layout = sashLayout(tmpDir);
    fs.mkdirSync(layout.binDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function staged(version: string, content = "new-core") {
    const exe = path.join(layout.binDir, `staged-${version}`);
    fs.writeFileSync(exe, content);
    return { version, exe };
  }

  it("commits binary and install metadata together after validation", async () => {
    fs.writeFileSync(layout.coreExe, "old-core");
    writeInstallRecord({ coreVersion: "v1", installedAt: "2025-01-01T00:00:00.000Z" }, layout);

    const result = await commitCoreUpdate({ layout, staged: staged("v2") });

    assert.equal(result.version, "v2");
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "new-core");
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
  });

  it("restores binary and metadata when the new runtime health check fails", async () => {
    fs.writeFileSync(layout.coreExe, "old-core");
    const previous = { coreVersion: "v1", installedAt: "2025-01-01T00:00:00.000Z" };
    writeInstallRecord(previous, layout);

    let starts = 0;
    let stops = 0;
    const runtime: CoreUpdateRuntime = {
      verifyRuntime: true,
      stop: async () => {
        stops += 1;
      },
      startAndVerify: async () => {
        starts += 1;
        if (starts === 1) throw new Error("new core unhealthy");
      },
    };

    await assert.rejects(
      () => commitCoreUpdate({ layout, staged: staged("v2"), runtime }),
      /new core unhealthy/,
    );

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "old-core");
    assert.deepEqual(readInstallRecord(layout), previous);
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
    assert.equal(starts, 2, "old core should be restarted after rollback");
    assert.equal(stops, 2, "new runtime should be stopped before restoring the old binary");
  });

  it("recovers an interrupted backup before applying the next update", async () => {
    fs.writeFileSync(`${layout.coreExe}.bak`, "recovered-old-core");
    writeInstallRecord({ coreVersion: "v1", installedAt: "2025-01-01T00:00:00.000Z" }, layout);

    await commitCoreUpdate({
      layout,
      staged: staged("v2"),
      verifyExecutable: (exe, expected) => {
        if (expected !== "v1" || fs.readFileSync(exe, "utf8") !== "recovered-old-core") {
          throw new Error("mismatch");
        }
      },
    });

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "new-core");
    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
  });

  it("rolls back an uncommitted current binary when the backup matches metadata", async () => {
    fs.writeFileSync(layout.coreExe, "v2-core");
    fs.writeFileSync(`${layout.coreExe}.bak`, "v1-core");
    writeInstallRecord({ coreVersion: "v1", installedAt: "2025-01-01T00:00:00.000Z" }, layout);
    let recoveredBeforeStop = "";
    const runtime: CoreUpdateRuntime = {
      verifyRuntime: true,
      stop: async () => {
        recoveredBeforeStop ||= fs.readFileSync(layout.coreExe, "utf8");
      },
      startAndVerify: async () => {},
    };

    await commitCoreUpdate({
      layout,
      staged: staged("v3", "v3-core"),
      runtime,
      verifyExecutable: (exe, expected) => {
        if (fs.readFileSync(exe, "utf8") !== `${expected}-core`) throw new Error("mismatch");
      },
    });

    assert.equal(recoveredBeforeStop, "v1-core");
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v3-core");
  });

  it("finishes a committed interrupted update by discarding its stale backup", async () => {
    fs.writeFileSync(layout.coreExe, "v2-core");
    fs.writeFileSync(`${layout.coreExe}.bak`, "v1-core");
    writeInstallRecord({ coreVersion: "v2", installedAt: "2025-01-01T00:00:00.000Z" }, layout);

    await commitCoreUpdate({
      layout,
      staged: staged("v3", "v3-core"),
      verifyExecutable: (exe, expected) => {
        if (fs.readFileSync(exe, "utf8") !== `${expected}-core`) throw new Error("mismatch");
      },
    });

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v3-core");
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
  });

  it("retains a verified rollback slot until external runtime restoration succeeds", async () => {
    fs.writeFileSync(layout.coreExe, "v1-core");
    writeInstallRecord({ coreVersion: "v1", installedAt: "2025-01-01T00:00:00.000Z" }, layout);
    const verify = (exe: string, expected: string) => {
      if (fs.readFileSync(exe, "utf8") !== `${expected}-core`) throw new Error("mismatch");
    };

    const result = await commitCoreUpdate({
      layout,
      staged: staged("v2", "v2-core"),
      retainBackup: true,
      verifyExecutable: verify,
    });

    assert.equal(result.backupRemoved, false);
    assert.equal(fs.readFileSync(`${layout.coreExe}.bak`, "utf8"), "v1-core");
    recoverInterruptedCoreUpdate(layout, verify, true);
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
  });

  it("rejects a backup-only recovery when it does not match install metadata", () => {
    fs.writeFileSync(`${layout.coreExe}.bak`, "corrupt-core");
    writeInstallRecord({ coreVersion: "v1", installedAt: "2025-01-01T00:00:00.000Z" }, layout);

    assert.throws(
      () =>
        recoverInterruptedCoreUpdate(layout, (exe, expected) => {
          if (fs.readFileSync(exe, "utf8") !== `${expected}-core`) throw new Error("mismatch");
        }),
      /does not match committed version/,
    );
    assert.equal(fs.existsSync(layout.coreExe), false);
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), true);
  });

  it("preserves candidate and backup when a running candidate cannot be stopped", async () => {
    fs.writeFileSync(layout.coreExe, "old-core");
    const previous = { coreVersion: "v1", installedAt: "2025-01-01T00:00:00.000Z" };
    writeInstallRecord(previous, layout);
    let stops = 0;
    const runtime: CoreUpdateRuntime = {
      verifyRuntime: true,
      stop: async () => {
        stops++;
        if (stops > 1) throw new Error("candidate still running");
      },
      startAndVerify: async () => {
        throw new Error("candidate unhealthy");
      },
    };

    await assert.rejects(
      () => commitCoreUpdate({ layout, staged: staged("v2"), runtime }),
      /candidate unhealthy; rollback also failed: candidate still running/,
    );

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "new-core");
    assert.equal(fs.readFileSync(`${layout.coreExe}.bak`, "utf8"), "old-core");
    assert.deepEqual(readInstallRecord(layout), previous);
  });
});
