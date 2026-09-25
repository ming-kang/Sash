import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sashLayout } from "./paths.js";
import { parseProfilesIndex, parseProfileText, profileFilePath } from "./profiles.js";

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
  it("refuses unsafe paths and reads damaged metadata leniently", () => {
    const layout = sashLayout("/nonexistent/sash-profiles-test");
    for (const id of ["../escape", "a/b", "C:\\outside"])
      assert.throws(() => profileFilePath(layout, id, 1));
    for (const revision of [0, -1, 0.5, Infinity])
      assert.throws(() => profileFilePath(layout, "123", revision));

    assert.equal(parseProfilesIndex({ activeId: "missing", profiles: [meta] }).activeId, null);
    assert.equal(parseProfilesIndex({ activeId: null, profiles: [meta, meta] }).profiles.length, 1);

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
  it("rejects non-object, invalid or oversized sources", () => {
    for (const text of ["scalar", "[]", "rules: [", ""])
      assert.throws(() => parseProfileText(text));
    assert.throws(() => parseProfileText(`# ${"x".repeat(8 * 1024 * 1024)}`));
    assert.deepEqual(parseProfileText("dns: {}\n"), { dns: {} });
  });
});
