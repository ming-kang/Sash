import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { loadSettings, readState, SashStateStore } from "./app-state.js";
import { sashLayout } from "./paths.js";
import { createTestState, testProfile } from "./testing/state.js";

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

  it("reuses a deeply frozen snapshot until the next committed revision", () => {
    const state = createTestState(sashLayout(root));
    state.commit({
      ...state.snapshot(),
      profiles: {
        activeId: "1",
        profiles: [{ ...testProfile(), subInfo: { upload: 1, download: 2, total: 3 } }],
      },
    });
    const before = state.snapshot();
    assert.equal(state.snapshot(), before);
    assert.ok(Object.isFrozen(before));
    assert.ok(Object.isFrozen(before.settings));
    assert.ok(Object.isFrozen(before.profiles));
    assert.ok(Object.isFrozen(before.profiles.profiles));
    assert.ok(Object.isFrozen(before.profiles.profiles[0]));
    assert.ok(Object.isFrozen(before.profiles.profiles[0]?.subInfo));
    assert.throws(() => {
      before.settings.mixedPort = 18880;
    }, TypeError);
    assert.throws(() => {
      before.profiles.profiles.splice(0, 0);
    }, TypeError);
    const after = state.commit({ ...before, settings: { ...before.settings, mixedPort: 18880 } });
    assert.notEqual(after, before);
    assert.equal(state.snapshot(), after);
    assert.notEqual(before.settings.mixedPort, after.settings.mixedPort);
    assert.equal(after.revision, before.revision + 1);
  });

  it("publishes a backup beside the initial manifest and every committed revision", () => {
    const layout = sashLayout(root);
    const state = createTestState(layout);
    const initial = fs.readFileSync(layout.settingsFile, "utf8");
    assert.equal(fs.readFileSync(layout.settingsBackupFile, "utf8"), initial);
    if (process.platform !== "win32")
      assert.equal(fs.statSync(layout.settingsBackupFile).mode & 0o777, 0o600);
    const first = state.commit({
      ...state.snapshot(),
      settings: { ...state.snapshot().settings, mixedPort: 18881 },
    });
    const firstText = fs.readFileSync(layout.settingsFile, "utf8");
    assert.equal(fs.readFileSync(layout.settingsBackupFile, "utf8"), firstText);
    assert.equal(JSON.parse(firstText).revision, first.revision);
    state.commit({ ...first, settings: { ...first.settings, mixedPort: 18882 } });
    const latest = fs.readFileSync(layout.settingsFile, "utf8");
    assert.notEqual(latest, firstText);
    assert.equal(fs.readFileSync(layout.settingsBackupFile, "utf8"), latest);
  });

  it("keeps the committed manifest intact when the backup write fails", () => {
    const layout = sashLayout(root);
    const state = createTestState(layout);
    const rename = fs.renameSync;
    mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === layout.settingsBackupFile)
        throw Object.assign(new Error("backup disk full"), { code: "ENOSPC" });
      return rename(from, to);
    });
    const committed = state.commit({
      ...state.snapshot(),
      settings: { ...state.snapshot().settings, mixedPort: 18883 },
    });
    assert.equal(committed.settings.mixedPort, 18883);
    assert.equal(readState(layout)?.revision, 1);
  });

  it("preserves the old manifest when publication fails", () => {
    const layout = sashLayout(root);
    const state = createTestState(layout);
    const before = fs.readFileSync(layout.settingsFile, "utf8");
    const snapshot = state.snapshot();
    const rename = fs.renameSync;
    mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === layout.settingsFile)
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return rename(from, to);
    });
    assert.throws(() => state.commit(state.snapshot()), /disk full/);
    assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), before);
    assert.equal(state.snapshot().revision, 0);
    assert.equal(state.snapshot(), snapshot);
  });

  it("rejects corrupt, unsupported, oversized and non-regular state without rewriting", () => {
    const layout = sashLayout(root);
    for (const text of ["{ broken", '{"schemaVersion":1}', "null", '"text"']) {
      fs.writeFileSync(layout.settingsFile, text);
      assert.throws(
        () => new SashStateStore(layout),
        (error) => error instanceof Error && error.message.includes(layout.settingsFile),
      );
      assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), text);
    }
    fs.truncateSync(layout.settingsFile, 2 * 1024 * 1024 + 1);
    assert.throws(
      () => readState(layout),
      (error) =>
        error instanceof Error &&
        error.message.includes(layout.settingsFile) &&
        /bounded/.test(error.message),
    );
    fs.unlinkSync(layout.settingsFile);
    fs.mkdirSync(layout.settingsFile);
    assert.throws(() => readState(layout), /bounded/);
  });
});
