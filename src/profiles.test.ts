import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { sashLayout } from "./paths.js";
import { parseProfilesIndex } from "./profile-model.js";
import {
  parseProfileText,
  profileDueForUpdate,
  profileFilePath,
  readProfileText,
} from "./profiles.js";

const meta = {
  id: "123",
  revision: 1,
  name: "test",
  url: "https://example.test/profile",
  intervalHours: 6,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
describe("profile input boundaries", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-profile-input-test-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("refuses unsafe paths and reads damaged metadata leniently", () => {
    const layout = sashLayout(root);
    for (const id of ["../escape", "a/b", "C:\\outside"])
      assert.throws(() => profileFilePath(layout, id, 1));
    for (const revision of [0, -1, 0.5, Infinity])
      assert.throws(() => profileFilePath(layout, "123", revision));

    // A dangling selection reads as "no active profile"; duplicate ids keep the first entry.
    assert.equal(parseProfilesIndex({ activeId: "missing", profiles: [meta] }).activeId, null);
    assert.equal(parseProfilesIndex({ activeId: null, profiles: [meta, meta] }).profiles.length, 1);

    // Damaged fields degrade instead of discarding the entry; unknown fields are ignored.
    const damaged = parseProfilesIndex({
      activeId: null,
      profiles: [
        {
          ...meta,
          intervalHours: Infinity,
          url: "file:///secret",
          homePage: "javascript:alert(1)",
          subInfo: { total: -1 },
          lastAttemptAt: "today",
          failureCount: -1,
          surprise: true,
        },
      ],
    }).profiles[0];
    assert.ok(damaged);
    assert.equal(damaged.intervalHours, 24);
    assert.equal(damaged.url, "file:///secret");
    assert.equal(damaged.homePage, undefined);
    assert.equal(damaged.subInfo, undefined);
    assert.equal(damaged.lastAttemptAt, "today");
    assert.equal(damaged.failureCount, undefined);

    // An entry without a usable source reference is skipped, not fatal.
    assert.equal(
      parseProfilesIndex({ activeId: null, profiles: [{ ...meta, revision: 0 }, meta] }).profiles
        .length,
      1,
    );
    assert.deepEqual(
      parseProfilesIndex({ activeId: null, profiles: [{ ...meta, id: "../x" }] }).profiles,
      [],
    );
  });
  it("bounds raw sources and rejects invalid roots", () => {
    const layout = sashLayout(root);
    const file = profileFilePath(layout, meta.id, meta.revision);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "rules: [MATCH,DIRECT]\n");
    assert.equal(readProfileText(layout, meta), "rules: [MATCH,DIRECT]\n");
    fs.truncateSync(file, 8 * 1024 * 1024 + 1);
    assert.throws(() => readProfileText(layout, meta), /bounded/);
    for (const text of ["scalar", "[]", "rules: [", ""])
      assert.throws(() => parseProfileText(text));
    assert.deepEqual(parseProfileText("dns: {}\n"), { dns: {} });
  });
  it("updates only remote profiles whose interval elapsed", () => {
    const now = Date.parse(meta.updatedAt) + 6 * 3_600_000;
    assert.equal(profileDueForUpdate(meta, now), true);
    assert.equal(profileDueForUpdate(meta, now - 1), false);
    assert.equal(profileDueForUpdate({ ...meta, url: "" }, now), false);
    assert.equal(profileDueForUpdate({ ...meta, intervalHours: 0 }, now), false);
  });
  it("doubles retry delays from fifteen minutes up to one day", () => {
    const attempted = Date.parse(meta.updatedAt) + 6 * 3_600_000;
    for (const [failureCount, minutes] of [
      [1, 15],
      [2, 30],
      [3, 60],
      [8, 1440],
      [31, 1440],
    ] as const) {
      const failed = {
        ...meta,
        failureCount,
        lastError: "offline",
        lastAttemptAt: new Date(attempted).toISOString(),
      };
      assert.equal(profileDueForUpdate(failed, attempted + minutes * 60_000 - 1), false);
      assert.equal(profileDueForUpdate(failed, attempted + minutes * 60_000), true);
    }
  });
});
