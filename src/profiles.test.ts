import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type SashLayout, sashLayout } from "./paths.js";
import {
  findProfileByUrl,
  getActiveProfile,
  loadProfiles,
  type ProfileMeta,
  profileDueForUpdate,
  profileFilePath,
  profileNameFromUrl,
  readProfileDoc,
  saveProfiles,
  serializeProfiles,
} from "./profiles.js";

const VALID_YAML = "proxies:\n  - name: node-a\n    type: direct\nrules:\n  - MATCH,DIRECT\n";
const NOW = "2026-01-01T00:00:00.000Z";

function meta(id: string, overrides: Partial<ProfileMeta> = {}): ProfileMeta {
  return {
    id,
    name: `profile-${id}`,
    url: "",
    intervalHours: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("profiles store", () => {
  let tmpDir: string;
  let layout: SashLayout;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-profiles-test-"));
    layout = sashLayout(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts empty and tolerates a missing index", () => {
    assert.deepEqual(loadProfiles(layout), { activeId: null, profiles: [] });
  });

  it("serializes and saves only a valid active selection", () => {
    const a = meta("1");
    const serialized = serializeProfiles({ activeId: "999", profiles: [a] });
    assert.deepEqual(JSON.parse(serialized), { activeId: null, profiles: [a] });

    saveProfiles({ activeId: a.id, profiles: [a] }, layout);
    assert.deepEqual(loadProfiles(layout), { activeId: a.id, profiles: [a] });
  });

  it("reads stored profile YAML and rejects invalid or missing content", () => {
    const profile = meta("1");
    saveProfiles({ activeId: profile.id, profiles: [profile] }, layout);
    fs.writeFileSync(profileFilePath(layout, profile.id), VALID_YAML);

    assert.deepEqual(readProfileDoc(layout, profile.id)?.rules, ["MATCH,DIRECT"]);
    fs.writeFileSync(profileFilePath(layout, profile.id), "just a string\n");
    assert.throws(() => readProfileDoc(layout, profile.id), /not a valid core configuration/);
    assert.equal(readProfileDoc(layout, "9999999999999"), undefined);
  });

  it("rejects non-numeric profile ids before constructing a path", () => {
    assert.throws(() => profileFilePath(layout, "../evil"));
    assert.throws(() => profileFilePath(layout, "a/b"));
  });

  it("rejects corrupt, duplicate, and unexpected index data without overwriting it", () => {
    fs.mkdirSync(layout.profilesDir, { recursive: true });
    const corrupt = "{ definitely not json";
    fs.writeFileSync(layout.profilesIndexFile, corrupt);
    assert.throws(() => loadProfiles(layout), /invalid JSON/);
    assert.equal(fs.readFileSync(layout.profilesIndexFile, "utf8"), corrupt);

    const profile = meta("1");
    fs.writeFileSync(
      layout.profilesIndexFile,
      JSON.stringify({ activeId: null, profiles: [profile, profile] }),
    );
    assert.throws(() => loadProfiles(layout), /duplicate profile ids/);

    fs.writeFileSync(
      layout.profilesIndexFile,
      JSON.stringify({ activeId: null, profiles: [profile], unexpected: true }),
    );
    assert.throws(() => loadProfiles(layout), /unexpected root fields/);
  });

  it("drops a dangling activeId and finds only non-local profiles by URL", () => {
    const local = meta("1");
    const remote = meta("2", { url: "https://x.test/s", intervalHours: 24 });
    saveProfiles({ activeId: "999", profiles: [local, remote] }, layout);

    const index = loadProfiles(layout);
    assert.equal(index.activeId, null);
    assert.equal(getActiveProfile(index), null);
    assert.equal(findProfileByUrl(index, "https://x.test/s")?.id, remote.id);
    assert.equal(findProfileByUrl(index, ""), null);
  });

  it("calculates remote update eligibility from URL, interval, file presence, and age", () => {
    const now = Date.now();
    const fresh = meta("1", {
      url: "https://x.test/s",
      intervalHours: 24,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    assert.equal(profileDueForUpdate({ ...fresh, url: "" }, false, now), false);
    assert.equal(profileDueForUpdate({ ...fresh, intervalHours: 0 }, false, now), false);
    assert.equal(profileDueForUpdate(fresh, false, now), true);
    assert.equal(profileDueForUpdate(fresh, true, now), false);
    assert.equal(
      profileDueForUpdate(
        { ...fresh, updatedAt: new Date(now - 25 * 3_600_000).toISOString() },
        true,
        now,
      ),
      true,
    );
  });

  it("derives a safe display-name fallback from a URL", () => {
    assert.equal(profileNameFromUrl("https://file.example.com/sub?token=1"), "file.example.com");
    assert.equal(profileNameFromUrl("not a url"), "profile");
  });
});
