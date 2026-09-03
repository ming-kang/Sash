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
  validateCoreReleaseTag,
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

  it("parses and projects only the canonical fixed shape", () => {
    const record = {
      coreVersion: "v1.2.3",
      installedAt: "2026-01-01T00:00:00.000Z",
    };

    assert.deepEqual(parseInstallRecord(record), record);
    assert.equal(parseInstallRecord({ ...record, extra: true }), undefined);
    assert.equal(parseInstallRecord({ ...record, installedAt: "2026-01-01" }), undefined);
    assert.equal(parseInstallRecord({ ...record, coreVersion: "../../escape" }), undefined);
  });

  it("writes, reads, and reports one canonical committed record", () => {
    const record = {
      coreVersion: "v1.2.3",
      installedAt: "2026-01-01T00:00:00.000Z",
    };

    writeInstallRecord(record, layout);

    assert.deepEqual(readInstallRecord(layout), record);
    assert.equal(currentCoreVersion(layout), "v1.2.3");
    assert.equal(installRecordsEqual(readInstallRecord(layout), record), true);
    assert.equal(installRecordsEqual(undefined, null), true);
  });

  it("rejects invalid tags and timestamps before publication", () => {
    assert.equal(validateCoreReleaseTag(" v1.2.3 "), "v1.2.3");
    assert.throws(() => validateCoreReleaseTag("tag/asset"), /Invalid Core release tag/);
    assert.throws(
      () =>
        writeInstallRecord({ coreVersion: "v1.2.3", installedAt: "2026-01-01T00:00:00Z" }, layout),
      /Invalid Core install timestamp/,
    );
    assert.equal(fs.existsSync(layout.installFile), false);
  });
});
