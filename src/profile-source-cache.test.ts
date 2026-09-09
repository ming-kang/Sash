import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { sashLayout } from "./paths.js";
import { ProfileSourceCache } from "./profile-source-cache.js";
import { profileFilePath, renderActiveConfig } from "./profiles.js";
import { createTestState, testProfile } from "./test-state.test.js";

it("reuses immutable parsed sources, evicts by size and detects replacement or removal", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sash-source-cache-"));
  t.after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  const layout = sashLayout(root);
  const cache = new ProfileSourceCache(layout, 80);
  const profile = testProfile("1");
  const file = profileFilePath(layout, profile.id, 1);
  atomicWriteFileSync(file, "proxies: []\nrules: [MATCH,DIRECT]\n");
  const first = cache.read(profile);
  assert.equal(cache.read(profile), first);
  assert.ok(Object.isFrozen(first.doc));
  assert.ok(Object.isFrozen(first.doc.rules));
  const state = createTestState(layout);
  state.commit({ ...state.snapshot(), profiles: { activeId: profile.id, profiles: [profile] } });
  assert.match(renderActiveConfig(state.snapshot(), layout, cache).yaml, /mixed-port:/);
  assert.equal(cache.read(profile), first);
  atomicWriteFileSync(file, "proxies: []\nrules: [MATCH,REJECT]\n");
  assert.notEqual(cache.read(profile), first);
  assert.deepEqual(cache.read(profile).doc.rules, ["MATCH", "REJECT"]);
  const second = cache.read(profile);
  atomicWriteFileSync(profileFilePath(layout, "2", 1), `rules: [${"DIRECT,".repeat(6)}DIRECT]\n`);
  cache.read(testProfile("2"));
  assert.notEqual(
    cache.read(profile),
    second,
    "least recently used source is reparsed after eviction",
  );
  fs.unlinkSync(file);
  assert.throws(() => cache.read(profile), /ENOENT/);
  fs.mkdirSync(file);
  assert.throws(() => cache.read(profile), /regular file/);
});
