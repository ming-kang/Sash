import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { sashLayout } from "./paths.js";
import { pruneProfileFiles } from "./profile-cleanup.js";
import { ProfileService } from "./profile-service.js";
import { createTestState, testProfile } from "./test-state.test.js";

it("cleans only old generated files and preserves referenced, recent, foreign and active temporary data", async (t) => {
  const isolation = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sash-prune-"));
  t.after(async () => {
    assert.equal(
      path.dirname(await fs.promises.realpath(isolation)).toLowerCase(),
      (await fs.promises.realpath(os.tmpdir())).toLowerCase(),
    );
    await fs.promises.rm(isolation, { recursive: true, force: true });
  });
  const layout = sashLayout(path.join(isolation, "data"));
  fs.mkdirSync(layout.root);
  const now = Date.now();
  const old = new Date(now - 2 * 24 * 60 * 60_000);
  const write = (relative: string, stale = true) => {
    const file = path.join(layout.root, relative);
    atomicWriteFileSync(file, "rules: [MATCH,DIRECT]\n");
    if (stale) fs.utimesSync(file, old, old);
    return file;
  };
  const referenced = write("profiles/1/1.yaml");
  const orphan = write("profiles/1/2.yaml");
  const recent = write("profiles/1/3.yaml", false);
  const notes = write("profiles/1/notes.txt");
  const deleted = write("profiles/2/1.yaml");
  const atomic = write("profiles/1/.4.yaml.123.abcdefabcdef.tmp");
  const validation = write("temp/config-validate-12345678-1234-1234-1234-123456789abc.yaml");
  const download = write(`temp/core-download-ABC123/${path.basename(layout.coreExe)}`);
  const unknown = write("temp/core-download-ABC123/keep.txt");
  const recentDirectory = path.join(layout.tempDir, "core-download-NEW123");
  const oldDirectory = path.join(layout.tempDir, "core-download-OLD123");
  fs.mkdirSync(recentDirectory);
  fs.mkdirSync(oldDirectory);
  fs.utimesSync(oldDirectory, old, old);
  const foreign = path.join(isolation, "foreign");
  fs.mkdirSync(foreign);
  const foreignFile = path.join(foreign, "1.yaml");
  atomicWriteFileSync(foreignFile, "private");
  fs.utimesSync(foreignFile, old, old);
  fs.symlinkSync(
    foreign,
    path.join(layout.profilesDir, "99"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const index = { activeId: "1", profiles: [testProfile("1")] };
  assert.equal(pruneProfileFiles(layout, index, { nowMs: now, cleanTemp: false }), 3);
  for (const file of [referenced, recent, notes, validation, download, unknown, foreignFile])
    assert.ok(fs.existsSync(file), file);
  for (const file of [orphan, deleted, atomic]) assert.equal(fs.existsSync(file), false, file);
  assert.equal(pruneProfileFiles(layout, index, { nowMs: now }), 2);
  assert.ok(fs.existsSync(unknown));
  assert.ok(fs.existsSync(foreignFile));
  assert.ok(
    fs.existsSync(recentDirectory),
    "an empty preparation directory still has a grace period",
  );
  assert.equal(fs.existsSync(oldDirectory), false);
  assert.ok(fs.existsSync(path.join(layout.profilesDir, "2")));
  fs.utimesSync(path.join(layout.profilesDir, "2"), old, old);
  pruneProfileFiles(layout, index, { nowMs: now });
  assert.equal(fs.existsSync(path.join(layout.profilesDir, "2")), false);

  const state = createTestState(layout);
  const candidate = write("profiles/1/8.yaml");
  const service = new ProfileService({
    layout,
    state,
    commit: async (_purpose, action) => action(),
  });
  fs.appendFileSync(layout.settingsFile, " ");
  await assert.rejects(service.cleanup(), /changed/);
  assert.ok(fs.existsSync(candidate), "a stale manifest must not authorize deletion");
});
