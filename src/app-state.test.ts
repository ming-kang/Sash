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

  it("commits one complete manifest and rejects stale writers", () => {
    const layout = sashLayout(root);
    const state = createTestState(layout);
    const before = state.snapshot();
    state.commit({ ...before, settings: { ...before.settings, mixedPort: 18880 } });
    assert.equal(readState(layout)?.settings.mixedPort, 18880);
    assert.equal(readState(layout)?.revision, 1);
    assert.throws(() => state.commit(before), /changed/);
    assert.equal(readState(layout)?.revision, 1);
  });

  it("keeps published state immutable across commits", () => {
    const state = createTestState(sashLayout(root));
    state.commit({
      ...state.snapshot(),
      profiles: {
        activeId: "1",
        profiles: [{ ...testProfile(), subInfo: { upload: 1, download: 2, total: 3 } }],
      },
    });
    const before = state.snapshot();
    assert.throws(() => {
      before.settings.mixedPort = 18880;
    }, TypeError);
    assert.throws(() => {
      before.profiles.profiles.splice(0, 0);
    }, TypeError);
    const after = state.commit({ ...before, settings: { ...before.settings, mixedPort: 18880 } });
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
    assert.deepEqual(state.snapshot(), snapshot);
  });

  it("accepts unknown manifest fields and rejects corrupt, unsupported or oversized state", () => {
    const layout = sashLayout(root);
    const store = createTestState(layout);
    store.commit({
      ...store.snapshot(),
      settings: { ...store.snapshot().settings, mixedPort: 18884 },
    });
    const committed = JSON.parse(fs.readFileSync(layout.settingsFile, "utf8")) as Record<
      string,
      unknown
    >;
    committed.futureField = { added: true };
    fs.writeFileSync(layout.settingsFile, JSON.stringify(committed));
    assert.equal(readState(layout)?.revision, 1);

    for (const text of ["{ broken", '{"schemaVersion":1}', "null", '"text"']) {
      fs.writeFileSync(layout.settingsFile, text);
      assert.throws(
        () => new SashStateStore(layout),
        (error) => error instanceof Error && error.message.includes(layout.settingsFile),
      );
      assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), text);
    }
    fs.truncateSync(layout.settingsFile, 2 * 1024 * 1024 + 1);
    assert.throws(() => readState(layout), /too large/);
    fs.unlinkSync(layout.settingsFile);
    fs.mkdirSync(layout.settingsFile);
    assert.throws(
      () => readState(layout),
      (error) => error instanceof Error && error.message.includes(layout.settingsFile),
    );
  });
});
