import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasExactOwnKeys, isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";

describe("JSON shape helpers", () => {
  it("accepts only ordinary plain objects", () => {
    class Example {}

    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject(JSON.parse('{"value":1}')), true);
    for (const value of [null, [], new Date(), new Example(), Object.create(null)]) {
      assert.equal(isPlainObject(value), false);
    }
  });

  it("matches exact own keys without depending on key order", () => {
    assert.equal(hasExactOwnKeys({ second: 2, first: 1 }, ["first", "second"]), true);
    assert.equal(hasExactOwnKeys({ first: 1 }, ["first", "second"]), false);
    assert.equal(hasExactOwnKeys({ first: 1, second: 2, extra: 3 }, ["first", "second"]), false);

    const inherited = Object.create({ second: 2 }) as Record<string, unknown>;
    inherited.first = 1;
    assert.equal(hasExactOwnKeys(inherited, ["first", "second"]), false);
  });

  it("accepts only canonical ISO timestamps", () => {
    assert.equal(isCanonicalIsoTimestamp("2026-09-02T00:00:00.000Z"), true);
    for (const value of [
      "2026-09-02T00:00:00Z",
      "2026-09-02T08:00:00.000+08:00",
      "not-a-date",
      "",
      0,
      null,
    ]) {
      assert.equal(isCanonicalIsoTimestamp(value), false);
    }
  });
});
