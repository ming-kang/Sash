import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  currentCoreVersion,
  parseInstallRecord,
  readInstallRecord,
  writeInstallRecord,
} from "./core.js";
import { type SashLayout, sashLayout } from "./paths.js";

describe("Core install record codec", () => {
  let root: string;
  let layout: SashLayout;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-core-install-record-test-"));
    layout = sashLayout(root);
  });

  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("parses the fields it needs and ignores the rest", () => {
    const record = { coreVersion: "v1.2.3" };

    assert.deepEqual(parseInstallRecord({ ...record, installedAt: "2026-01-01" }), record);
    assert.deepEqual(parseInstallRecord({ ...record, extra: true }), record);
    assert.equal(parseInstallRecord({ installedAt: "2026-01-01T00:00:00.000Z" }), undefined);
    assert.equal(parseInstallRecord({ ...record, coreVersion: "../../escape" }), undefined);
    assert.equal(parseInstallRecord(null), undefined);
    writeInstallRecord(record, layout);
    assert.deepEqual(readInstallRecord(layout), record);
  });

  it("reads leniently and reports one canonical committed record", () => {
    fs.mkdirSync(path.dirname(layout.installFile), { recursive: true });
    fs.writeFileSync(
      layout.installFile,
      JSON.stringify({
        coreVersion: "v1.2.3",
        installedAt: "2026-01-01T00:00:00.000Z",
        assetName: "mihomo-windows-amd64-v3-v1.2.3.zip",
      }),
    );

    assert.deepEqual(readInstallRecord(layout), { coreVersion: "v1.2.3" });
    assert.equal(currentCoreVersion(layout), "v1.2.3");

    fs.writeFileSync(layout.installFile, "{ broken");
    assert.equal(readInstallRecord(layout), undefined);
    assert.equal(currentCoreVersion(layout), "");

    writeInstallRecord({ coreVersion: "v1.2.4" }, layout);
    assert.deepEqual(readInstallRecord(layout), { coreVersion: "v1.2.4" });
  });

  it("caches the install record by mtime and size, avoiding repeated disk reads", () => {
    writeInstallRecord({ coreVersion: "v1.0.0" }, layout);

    const readSpy = mock.method(fs, "readFileSync");
    try {
      const first = readInstallRecord(layout);
      assert.deepEqual(first, { coreVersion: "v1.0.0" });
      const initialCalls = readSpy.mock.calls.length;
      assert.ok(initialCalls >= 1);

      // Repeated reads with unchanged mtime and size return the cached record without reading from disk
      const second = readInstallRecord(layout);
      assert.deepEqual(second, { coreVersion: "v1.0.0" });
      assert.equal(
        readSpy.mock.calls.length,
        initialCalls,
        "repeated read did not call readFileSync",
      );

      assert.equal(currentCoreVersion(layout), "v1.0.0");
      assert.equal(
        readSpy.mock.calls.length,
        initialCalls,
        "currentCoreVersion did not call readFileSync",
      );

      // Rewrite with new mtime is picked up
      const futureTime = new Date(Date.now() + 5000);
      fs.writeFileSync(layout.installFile, JSON.stringify({ coreVersion: "v2.0.0" }));
      fs.utimesSync(layout.installFile, futureTime, futureTime);

      const updated = readInstallRecord(layout);
      assert.deepEqual(updated, { coreVersion: "v2.0.0" });
      assert.equal(
        readSpy.mock.calls.length,
        initialCalls + 1,
        "rewrite with new mtime triggered a re-read",
      );

      // Repeated read of the new version stays cached
      const updatedCached = readInstallRecord(layout);
      assert.deepEqual(updatedCached, { coreVersion: "v2.0.0" });
      assert.equal(readSpy.mock.calls.length, initialCalls + 1, "subsequent read remained cached");

      // Corrupt rewrite is surfaced leniently as undefined without poisoning subsequent reads
      const corruptTime = new Date(Date.now() + 10000);
      fs.writeFileSync(layout.installFile, "{ invalid json");
      fs.utimesSync(layout.installFile, corruptTime, corruptTime);

      assert.equal(readInstallRecord(layout), undefined, "corrupt rewrite surfaces as undefined");
      assert.equal(
        currentCoreVersion(layout),
        "",
        "currentCoreVersion returns empty string on corrupt file",
      );

      // Recovery after corrupt file is rewritten with valid data
      const recoveryTime = new Date(Date.now() + 15000);
      writeInstallRecord({ coreVersion: "v3.0.0" }, layout);
      fs.utimesSync(layout.installFile, recoveryTime, recoveryTime);

      assert.deepEqual(readInstallRecord(layout), { coreVersion: "v3.0.0" });
    } finally {
      readSpy.mock.restore();
    }
  });

  it("handles missing file gracefully without throwing or poisoning cache", () => {
    assert.equal(readInstallRecord(layout), undefined);
    assert.equal(currentCoreVersion(layout), "");

    writeInstallRecord({ coreVersion: "v1.0.0" }, layout);
    assert.deepEqual(readInstallRecord(layout), { coreVersion: "v1.0.0" });

    fs.rmSync(layout.installFile, { force: true });
    assert.equal(readInstallRecord(layout), undefined);
    assert.equal(currentCoreVersion(layout), "");
  });
});
