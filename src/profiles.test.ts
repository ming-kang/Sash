import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type SashLayout, sashLayout } from "./paths.js";
import {
  addProfile,
  applySubscriptionFetch,
  findProfileByUrl,
  getActiveProfile,
  loadProfiles,
  migrateLegacySubscription,
  NEVER_UPDATED,
  profileDueForUpdate,
  profileFilePath,
  profileNameFromUrl,
  readProfileDoc,
  recordProfileError,
  removeProfile,
  setActiveProfile,
  updateProfile,
} from "./profiles.js";

const VALID_YAML = "proxies:\n  - name: node-a\n    type: direct\nrules:\n  - MATCH,DIRECT\n";
const VALID_YAML_2 = "proxies:\n  - name: node-b\n    type: direct\nrules:\n  - MATCH,DIRECT\n";

describe("profiles store", () => {
  let tmpDir: string;
  let layout: SashLayout;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-profiles-test-"));
    layout = sashLayout(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("starts empty and tolerates a missing index", () => {
    const index = loadProfiles(layout);
    assert.deepEqual(index, { activeId: null, profiles: [] });
  });

  it("addProfile writes the yaml file, indexes it, and auto-activates the first profile", () => {
    const first = addProfile(
      { name: "meow", url: "https://example.com/sub", yamlText: VALID_YAML },
      layout,
    );
    assert.equal(first.activated, true);
    assert.equal(first.index.activeId, first.profile.id);
    assert.equal(fs.readFileSync(profileFilePath(layout, first.profile.id), "utf8"), VALID_YAML);

    const second = addProfile(
      { name: "other", url: "https://example.com/2", yamlText: VALID_YAML_2 },
      layout,
    );
    assert.equal(second.activated, false);
    assert.equal(second.index.activeId, first.profile.id);

    // Adding twice in the same millisecond must still produce unique ids.
    assert.notEqual(first.profile.id, second.profile.id);

    const loaded = loadProfiles(layout);
    assert.equal(loaded.profiles.length, 2);
    assert.equal(loaded.activeId, first.profile.id);
  });

  it("readProfileDoc parses stored content and rejects junk", () => {
    const { profile } = addProfile({ name: "a", url: "", yamlText: VALID_YAML }, layout);
    const doc = readProfileDoc(layout, profile.id);
    assert.ok(doc);
    assert.deepEqual(doc.rules, ["MATCH,DIRECT"]);

    fs.writeFileSync(profileFilePath(layout, profile.id), "just a string\n");
    assert.equal(readProfileDoc(layout, profile.id), undefined);
    assert.equal(readProfileDoc(layout, "9999999999999"), undefined);
  });

  it("profileFilePath rejects non-numeric ids (path traversal guard)", () => {
    assert.throws(() => profileFilePath(layout, "../evil"));
    assert.throws(() => profileFilePath(layout, "a/b"));
  });

  it("updateProfile refreshes content, bumps updatedAt and clears lastError", () => {
    const { profile } = addProfile(
      { name: "a", url: "https://x.test/s", yamlText: VALID_YAML },
      layout,
    );
    recordProfileError(profile.id, "boom", layout);
    assert.equal(loadProfiles(layout).profiles[0]?.lastError, "boom");

    updateProfile(profile.id, { yamlText: VALID_YAML_2, name: "renamed" }, layout);
    const after = loadProfiles(layout).profiles[0];
    assert.equal(after?.name, "renamed");
    assert.equal(after?.lastError, undefined);
    assert.notEqual(after?.updatedAt, NEVER_UPDATED);
    assert.equal(fs.readFileSync(profileFilePath(layout, profile.id), "utf8"), VALID_YAML_2);
  });

  it("applySubscriptionFetch stores content and gateway metadata", () => {
    const { profile } = addProfile(
      { name: "a", url: "https://x.test/s", yamlText: VALID_YAML },
      layout,
    );
    applySubscriptionFetch(
      profile.id,
      {
        doc: { proxies: [], rules: ["MATCH,DIRECT"] },
        yamlText: VALID_YAML_2,
        subInfo: { upload: 1, download: 2, total: 100, expire: 2000000000 },
        homePage: "https://home.test",
        intervalHours: 12,
      },
      layout,
    );
    const after = loadProfiles(layout).profiles[0];
    assert.equal(after?.subInfo?.total, 100);
    assert.equal(after?.homePage, "https://home.test");
    assert.equal(after?.intervalHours, 12);
    assert.equal(fs.readFileSync(profileFilePath(layout, profile.id), "utf8"), VALID_YAML_2);
  });

  it("setActiveProfile selects, deselects and rejects unknown ids", () => {
    const a = addProfile({ name: "a", url: "", yamlText: VALID_YAML }, layout);
    const b = addProfile({ name: "b", url: "", yamlText: VALID_YAML_2 }, layout);
    assert.equal(getActiveProfile(loadProfiles(layout))?.id, a.profile.id);

    setActiveProfile(b.profile.id, layout);
    assert.equal(getActiveProfile(loadProfiles(layout))?.id, b.profile.id);

    setActiveProfile(null, layout);
    assert.equal(getActiveProfile(loadProfiles(layout)), null);

    assert.throws(() => setActiveProfile("1234567890123", layout));
  });

  it("removeProfile deletes the file and clears activeId when active", () => {
    const a = addProfile({ name: "a", url: "", yamlText: VALID_YAML }, layout);
    const b = addProfile({ name: "b", url: "", yamlText: VALID_YAML_2 }, layout);

    const r1 = removeProfile(a.profile.id, layout);
    assert.equal(r1.wasActive, true);
    assert.equal(r1.index.activeId, null);
    assert.equal(fs.existsSync(profileFilePath(layout, a.profile.id)), false);

    const r2 = removeProfile(b.profile.id, layout);
    assert.equal(r2.wasActive, false);
    assert.equal(loadProfiles(layout).profiles.length, 0);
    assert.throws(() => removeProfile("1234567890123", layout));
  });

  it("loadProfiles drops a dangling activeId", () => {
    const a = addProfile({ name: "a", url: "", yamlText: VALID_YAML }, layout);
    // Corrupt the index: point activeId at a non-existent profile.
    const raw = JSON.parse(fs.readFileSync(layout.profilesIndexFile, "utf8"));
    raw.activeId = "9999999999999";
    fs.writeFileSync(layout.profilesIndexFile, JSON.stringify(raw));
    const index = loadProfiles(layout);
    assert.equal(index.activeId, null);
    assert.equal(index.profiles.length, 1);
    assert.equal(index.profiles[0]?.id, a.profile.id);
  });

  it("findProfileByUrl matches remote profiles only", () => {
    addProfile({ name: "local", url: "", yamlText: VALID_YAML }, layout);
    addProfile({ name: "remote", url: "https://x.test/s", yamlText: VALID_YAML }, layout);
    const index = loadProfiles(layout);
    assert.equal(findProfileByUrl(index, "https://x.test/s")?.name, "remote");
    assert.equal(findProfileByUrl(index, ""), null);
    assert.equal(findProfileByUrl(index, "https://nope.test"), null);
  });

  it("profileDueForUpdate follows url/interval/file-presence rules", () => {
    const now = Date.now();
    const fresh = {
      id: "1",
      name: "a",
      url: "https://x.test/s",
      intervalHours: 24,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    // local file → never due
    assert.equal(profileDueForUpdate({ ...fresh, url: "" }, false, now), false);
    // interval disabled → never due
    assert.equal(profileDueForUpdate({ ...fresh, intervalHours: 0 }, false, now), false);
    // missing file → always due
    assert.equal(profileDueForUpdate(fresh, false, now), true);
    // fresh with file → not due
    assert.equal(profileDueForUpdate(fresh, true, now), false);
    // stale → due
    const stale = { ...fresh, updatedAt: new Date(now - 25 * 3_600_000).toISOString() };
    assert.equal(profileDueForUpdate(stale, true, now), true);
    // corrupt timestamp → due
    assert.equal(profileDueForUpdate({ ...fresh, updatedAt: "junk" }, true, now), true);
  });

  it("migrateLegacySubscription creates an active meta-only profile once", () => {
    const m1 = migrateLegacySubscription("https://x.test/legacy", layout);
    assert.equal(m1.created, true);
    assert.equal(m1.index.activeId, m1.index.profiles[0]?.id);
    assert.equal(m1.index.profiles[0]?.updatedAt, NEVER_UPDATED);
    assert.equal(m1.index.profiles[0]?.name, "x.test");

    const m2 = migrateLegacySubscription("https://x.test/legacy", layout);
    assert.equal(m2.created, false);
    assert.equal(m2.index.profiles.length, 1);

    // Empty url is a no-op.
    assert.equal(migrateLegacySubscription("", layout).created, false);
  });

  it("profileNameFromUrl falls back to the hostname", () => {
    assert.equal(profileNameFromUrl("https://file.example.com/sub?token=1"), "file.example.com");
    assert.equal(profileNameFromUrl("not a url"), "profile");
  });
});
