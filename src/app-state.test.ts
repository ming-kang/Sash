import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { loadSettings, readState, SashStateStore } from "./app-state.js";
import { sashLayout } from "./paths.js";
import { createTestState } from "./test-state.test.js";

describe("canonical Sash state", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-state-test-"));
  });
  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps missing-state reads free of initialization writes", () => {
    const layout = sashLayout(root);
    assert.equal(readState(layout), undefined);
    assert.equal(loadSettings(layout).secret, "");
    assert.deepEqual(fs.readdirSync(root), []);
    const state = new SashStateStore(layout);
    assert.ok(state.snapshot().settings.secret);
    assert.notEqual(state.snapshot().settings.secret, state.snapshot().settings.daemonSecret);
    if (process.platform !== "win32")
      assert.equal(fs.statSync(layout.settingsFile).mode & 0o777, 0o600);
  });

  it("commits one complete manifest and rejects stale writers and edited bytes", () => {
    const layout = sashLayout(root);
    const first = createTestState(layout);
    const stale = new SashStateStore(layout);
    const before = first.snapshot();
    first.commit({ ...before, settings: { ...before.settings, mixedPort: 18880 } });
    assert.equal(readState(layout)?.settings.mixedPort, 18880);
    assert.equal(readState(layout)?.revision, 1);
    assert.throws(() => stale.commit(stale.snapshot()), /changed/);
    const bytes = fs.readFileSync(layout.settingsFile, "utf8");
    fs.appendFileSync(layout.settingsFile, "\n");
    assert.throws(() => first.commit(first.snapshot()), /changed/);
    assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), `${bytes}\n`);
  });

  it("preserves the old manifest when publication fails", () => {
    const layout = sashLayout(root);
    const state = createTestState(layout);
    const before = fs.readFileSync(layout.settingsFile, "utf8");
    const rename = fs.renameSync;
    mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === layout.settingsFile)
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return rename(from, to);
    });
    assert.throws(() => state.commit(state.snapshot()), /disk full/);
    assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), before);
    assert.equal(state.snapshot().revision, 0);
  });

  it("rejects corrupt, unsupported, oversized and non-regular state without rewriting", () => {
    const layout = sashLayout(root);
    for (const text of ["{ broken", '{"schemaVersion":1}', "null", '"text"']) {
      fs.writeFileSync(layout.settingsFile, text);
      assert.throws(() => new SashStateStore(layout));
      assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), text);
    }
    fs.truncateSync(layout.settingsFile, 2 * 1024 * 1024 + 1);
    assert.throws(() => readState(layout), /bounded/);
    fs.unlinkSync(layout.settingsFile);
    fs.mkdirSync(layout.settingsFile);
    assert.throws(() => readState(layout), /bounded/);
  });
});
