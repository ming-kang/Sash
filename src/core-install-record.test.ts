import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  currentCoreVersion,
  installRecordsEqual,
  parseInstallRecord,
  readInstallRecord,
  writeInstallRecord,
} from "./core-install-record.js";
import { type SashLayout, sashLayout } from "./paths.js";

describe("Core install record codec", () => {
  let root: string;
  let layout: SashLayout;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-core-install-record-test-"));
    layout = sashLayout(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("parses the fields it needs and ignores the rest", () => {
    const record = { coreVersion: "v1.2.3", installedAt: "2026-01-01T00:00:00.000Z" };

    assert.deepEqual(parseInstallRecord({ ...record, extra: true }), record);
    assert.deepEqual(parseInstallRecord({ ...record, installedAt: "2026-01-01" }), {
      ...record,
      installedAt: "2026-01-01",
    });
    assert.equal(parseInstallRecord({ installedAt: record.installedAt }), undefined);
    assert.equal(parseInstallRecord({ ...record, coreVersion: "../../escape" }), undefined);
    assert.equal(parseInstallRecord(null), undefined);
    writeInstallRecord(record, layout);
    assert.deepEqual(readInstallRecord(layout), record);
  });

  it("writes, reads, and reports one canonical committed record", () => {
    const record = {
      coreVersion: "v1.2.3",
      installedAt: "2026-01-01T00:00:00.000Z",
      assetName: "mihomo-windows-amd64-v3-v1.2.3.zip",
    };

    writeInstallRecord(record, layout);

    assert.deepEqual(readInstallRecord(layout), record);
    assert.equal(currentCoreVersion(layout), "v1.2.3");
    assert.equal(installRecordsEqual(readInstallRecord(layout), record), true);
    assert.equal(installRecordsEqual(undefined, null), true);
  });
});
