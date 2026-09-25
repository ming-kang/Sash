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

  it("re-reads on every call, so a same-mtime rewrite is never stale", () => {
    writeInstallRecord({ coreVersion: "v1.0.0" }, layout);
    assert.deepEqual(readInstallRecord(layout), { coreVersion: "v1.0.0" });

    const readSpy = mock.method(fs, "readFileSync");
    try {
      const firstCalls = readSpy.mock.calls.length;
      readInstallRecord(layout);
      assert.ok(readSpy.mock.calls.length > firstCalls, "repeated read hit the disk");
    } finally {
      readSpy.mock.restore();
    }

    const sameMtime = fs.statSync(layout.installFile);
    fs.writeFileSync(layout.installFile, JSON.stringify({ coreVersion: "v2.0.0" }));
    fs.utimesSync(layout.installFile, sameMtime.atime, sameMtime.mtime);

    assert.deepEqual(readInstallRecord(layout), { coreVersion: "v2.0.0" });
    assert.equal(currentCoreVersion(layout), "v2.0.0");

    fs.writeFileSync(layout.installFile, "{ invalid json");
    assert.equal(readInstallRecord(layout), undefined, "corrupt rewrite surfaces as undefined");
    assert.equal(
      currentCoreVersion(layout),
      "",
      "currentCoreVersion returns empty string on corrupt file",
    );

    writeInstallRecord({ coreVersion: "v3.0.0" }, layout);
    assert.deepEqual(readInstallRecord(layout), { coreVersion: "v3.0.0" });
  });

  it("handles missing file gracefully", () => {
    assert.equal(readInstallRecord(layout), undefined);
    assert.equal(currentCoreVersion(layout), "");

    writeInstallRecord({ coreVersion: "v1.0.0" }, layout);
    assert.deepEqual(readInstallRecord(layout), { coreVersion: "v1.0.0" });

    fs.rmSync(layout.installFile, { force: true });
    assert.equal(readInstallRecord(layout), undefined);
    assert.equal(currentCoreVersion(layout), "");
  });
});
