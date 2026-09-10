import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { readState, type SashStateStore } from "./app-state.js";
import { DaemonGate } from "./daemon/context.js";
import type { SubscriptionFetch } from "./mihomo-config.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { ProfileService } from "./profile-service.js";
import { parseProfileText, profileFilePath } from "./profiles.js";
import { createTestState, deferred } from "./testing/state.js";

const yamlA = "proxies:\n  - name: node-a\n    type: direct\nrules: ['MATCH,DIRECT']\n";
const yamlB = yamlA.replace("node-a", "node-b");
const fetched = (yamlText = yamlA): SubscriptionFetch => ({
  doc: parseProfileText(yamlText),
  yamlText,
  intervalHours: 6,
  subInfo: { upload: 1, download: 2, total: 100 },
});

describe("saved profiles", () => {
  let root: string;
  let layout: SashLayout;
  let state: SashStateStore;
  let gate: DaemonGate;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-profiles-test-"));
    layout = sashLayout(root);
    state = createTestState(layout);
    gate = new DaemonGate(
      async () => {},
      () => {},
    );
  });
  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function service(
    fetchProfile: (url: string, signal?: AbortSignal) => Promise<SubscriptionFetch> = async () =>
      fetched(),
  ) {
    return new ProfileService({
      layout,
      state,
      commit: (action) => gate.mutate(action),
      fetchProfile,
    });
  }

  it("stores complete sources and metadata without publishing runtime config", async () => {
    const profiles = service();
    const first = await profiles.addRemote("https://example.test/a");
    const second = await profiles.importLocal("local", yamlB);
    assert.equal(first.activated, true);
    assert.equal(second.activated, false);
    assert.equal(first.profile.intervalHours, 6);
    assert.equal(first.profile.subInfo?.total, 100);
    assert.equal(profiles.readContent(first.profile.id).content, yamlA);
    assert.equal(readState(layout)?.profiles.profiles.length, 2);
    assert.equal(fs.existsSync(layout.configFile), false);
  });

  it("saves selection, rename, order, and deletion without touching the running config", async () => {
    const profiles = service();
    const a = (await profiles.importLocal("a", yamlA)).profile;
    const b = (await profiles.importLocal("b", yamlB)).profile;
    fs.writeFileSync(layout.configFile, "running config");
    await profiles.activate(b.id);
    await profiles.rename(a.id, " renamed ");
    await profiles.reorder([b.id, a.id]);
    assert.equal(profiles.list().profiles[1]?.name, "renamed");
    assert.equal(profiles.list().profiles[1]?.revision, a.revision);
    assert.deepEqual(await profiles.remove(b.id), { wasActive: true });
    assert.equal(profiles.list().activeId, null);
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "running config");
    await assert.rejects(profiles.reorder([a.id, a.id]), /every profile/);
    await assert.rejects(profiles.rename(a.id, " "), /1 to 120/);
  });

  it("rejects invalid YAML before any publication and refuses missing selected sources", async () => {
    const profiles = service();
    for (const text of ["proxies: [", "scalar", "- not-a-root-map"])
      await assert.rejects(profiles.importLocal("bad", text));
    assert.equal(state.snapshot().revision, 0);
    const a = (await profiles.importLocal("a", yamlA)).profile;
    const b = (await profiles.importLocal("b", yamlB)).profile;
    fs.unlinkSync(profileFilePath(layout, b.id, b.revision));
    await assert.rejects(profiles.activate(b.id));
    assert.equal(profiles.list().activeId, a.id);
  });

  it("uses editor revisions so one tab cannot overwrite another saved edit", async () => {
    const profiles = service();
    const a = (await profiles.importLocal("a", yamlA)).profile;
    const edited = await profiles.writeContent(a.id, yamlB, a.revision);
    assert.ok(edited.profile.revision > a.revision);
    await assert.rejects(
      profiles.writeContent(a.id, yamlA, a.revision),
      /changed since the editor/,
    );
    assert.equal(profiles.readContent(a.id).content, yamlB);
    const unchanged = await profiles.writeContent(a.id, yamlB, edited.profile.revision);
    assert.equal(unchanged.profile.revision, edited.profile.revision);
  });

  it("keeps the old reference after a crash between source and manifest publication", async () => {
    const profiles = service();
    const a = (await profiles.importLocal("a", yamlA)).profile;
    const before = fs.readFileSync(layout.settingsFile, "utf8");
    const rename = fs.renameSync;
    mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === layout.settingsFile)
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return rename(from, to);
    });
    await assert.rejects(profiles.writeContent(a.id, yamlB, a.revision), /disk full/);
    assert.equal(fs.readFileSync(layout.settingsFile, "utf8"), before);
    assert.equal(profiles.readContent(a.id).content, yamlA);
    assert.equal(fs.readFileSync(profileFilePath(layout, a.id, a.revision + 1), "utf8"), yamlB);
    mock.restoreAll();
    const updated = await profiles.writeContent(a.id, yamlB, a.revision);
    assert.ok(updated.profile.revision > a.revision + 1);
  });

  it("does not let late downloads or their errors replace newer content", async () => {
    const profiles = service();
    const remote = (await profiles.addRemote("https://example.test/a")).profile;
    const entered = deferred();
    const release = deferred();
    const slow = service(async () => {
      entered.resolve();
      await release.promise;
      return fetched();
    });
    const pending = slow.update(remote.id);
    const rejected = assert.rejects(pending, /changed while downloading/);
    await entered.promise;
    await profiles.writeContent(remote.id, yamlB, remote.revision);
    release.resolve();
    await rejected;
    assert.equal(profiles.readContent(remote.id).content, yamlB);
    assert.equal(profiles.list().profiles[0]?.lastError, undefined);
  });

  it("retains names and content revisions when remote bytes are unchanged", async () => {
    const profiles = service();
    const remote = (await profiles.addRemote("https://example.test/a")).profile;
    await profiles.rename(remote.id, "mine");
    const result = await profiles.update(remote.id);
    assert.equal(result.profile.name, "mine");
    assert.equal(result.profile.revision, remote.revision);
  });

  it("fetches independent updates concurrently and reports per-profile failure", async () => {
    const profiles = service();
    await profiles.addRemote("https://example.test/a");
    await profiles.addRemote("https://example.test/b");
    let active = 0;
    let peak = 0;
    const updating = service(async (url) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      if (url.endsWith("b")) throw new Error("offline");
      return fetched(yamlB);
    });
    const result = await updating.updateAll();
    assert.equal(peak, 2);
    assert.equal(result.updated, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(profiles.list().profiles[1]?.lastError, "offline");
  });

  it("shares one download and publication across manual, all and scheduled updates", async () => {
    const entered = deferred();
    const release = deferred();
    let hold = false;
    let downloads = 0;
    const profiles = service(async () => {
      downloads += 1;
      if (hold) {
        entered.resolve();
        await release.promise;
      }
      return fetched(hold ? yamlB : yamlA);
    });
    const remote = (await profiles.addRemote("https://example.test/a")).profile;
    const snapshot = state.snapshot();
    state.commit({
      ...snapshot,
      profiles: {
        ...snapshot.profiles,
        profiles: snapshot.profiles.profiles.map((profile) => ({
          ...profile,
          updatedAt: "2000-01-01T00:00:00.000Z",
        })),
      },
    });
    const revision = state.snapshot().revision;
    hold = true;
    const manual = profiles.update(remote.id);
    const all = profiles.updateAll();
    const scheduled = profiles.updateDue();
    await entered.promise;
    assert.equal(profiles.update(remote.id), manual);
    release.resolve();
    const results = await Promise.all([manual, all, scheduled]);
    assert.equal(downloads, 2);
    assert.equal(results[1].updated, 1);
    assert.equal(results[2].updated, 1);
    assert.equal(state.snapshot().revision, revision + 1);
    assert.equal(profiles.readContent(remote.id).content, yamlB);
  });

  it("backs off scheduled failures while allowing manual recovery", async () => {
    let failing = false;
    let downloads = 0;
    const profiles = service(async () => {
      downloads += 1;
      if (failing) throw new Error("provider offline");
      return fetched();
    });
    const remote = (await profiles.addRemote("https://example.test/a")).profile;
    const snapshot = state.snapshot();
    state.commit({
      ...snapshot,
      profiles: {
        ...snapshot.profiles,
        profiles: snapshot.profiles.profiles.map((profile) => ({
          ...profile,
          updatedAt: "2000-01-01T00:00:00.000Z",
        })),
      },
    });
    failing = true;
    assert.equal((await profiles.updateDue()).failed.length, 1);
    assert.equal(profiles.active()?.failureCount, 1);
    assert.ok(profiles.active()?.lastAttemptAt);
    assert.deepEqual(await profiles.updateDue(), { updated: 0, failed: [] });
    assert.equal(downloads, 2);
    await assert.rejects(profiles.update(remote.id), /provider offline/);
    assert.equal(profiles.active()?.failureCount, 2);
    failing = false;
    await profiles.update(remote.id);
    assert.equal(profiles.active()?.failureCount, 0);
    assert.equal(profiles.active()?.lastError, undefined);
    assert.equal(downloads, 4);
  });

  it("does not count cancelled updates as provider failures", async () => {
    const profiles = service();
    const remote = (await profiles.addRemote("https://example.test/a")).profile;
    const entered = deferred();
    const updating = service(async (_url, signal) => {
      entered.resolve();
      await new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
      return fetched();
    });
    const revision = state.snapshot().revision;
    const pending = assert.rejects(updating.update(remote.id), /cancelled/);
    await entered.promise;
    updating.cancelDownloads();
    await pending;
    assert.equal(state.snapshot().revision, revision);
    assert.equal(profiles.active()?.failureCount, 0);
    assert.equal(profiles.active()?.lastError, undefined);
  });

  it("cancels outstanding download bodies", async () => {
    const entered = deferred();
    const profiles = service(async (_url, signal) => {
      entered.resolve();
      await new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
      return fetched();
    });
    const pending = profiles.addRemote("https://example.test/a");
    const rejected = assert.rejects(pending, /cancelled/);
    await entered.promise;
    profiles.cancelDownloads();
    await rejected;
    assert.equal(profiles.list().profiles.length, 0);
  });
});
