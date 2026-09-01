import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readInstallRecord, writeInstallRecord } from "./core.js";
import { type CoreUpdateRuntime, commitCoreUpdate } from "./core-update.js";
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
      wasRunning: true,
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

    await commitCoreUpdate({ layout, staged: staged("v2") });

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "new-core");
    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
  });
});
