import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { errorPresentation, parseErrorPresentation, withErrorPresentation } from "./error-utils.js";

describe("error presentation", () => {
  it("attaches a non-enumerable presentation while keeping the error subclass", () => {
    class FixtureError extends Error {}
    const error = withErrorPresentation(new FixtureError("raw"), {
      message: "friendly",
      advice: "do the thing",
    });
    assert.ok(error instanceof FixtureError);
    assert.equal(error.message, "raw");
    assert.deepEqual(errorPresentation(error), { message: "friendly", advice: "do the thing" });
    assert.deepEqual(Object.keys(error), []);
    assert.equal(JSON.stringify(error), "{}");
  });

  it("returns undefined for errors or payloads without a presentation", () => {
    assert.equal(errorPresentation(new Error("plain")), undefined);
    assert.equal(errorPresentation("failure"), undefined);
    assert.equal(errorPresentation(null), undefined);
  });

  it("parses only well-formed presentation payloads", () => {
    assert.deepEqual(parseErrorPresentation({ message: "m", advice: "a" }), {
      message: "m",
      advice: "a",
    });
    assert.deepEqual(parseErrorPresentation({ message: "m" }), { message: "m" });
    assert.equal(parseErrorPresentation({ message: "m", advice: 3 }), undefined);
    assert.equal(parseErrorPresentation({ advice: "a" }), undefined);
    assert.equal(parseErrorPresentation("m"), undefined);
    assert.equal(parseErrorPresentation({}), undefined);
  });
});
