import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { apiErrorBody, parseApiErrorBody, SashApiError } from "./contracts.js";
import { errorPresentation } from "./error-utils.js";

describe("API error bodies", () => {
  it("round-trips an optional presentation through JSON", () => {
    const presentation = { message: "friendly words", advice: "do the thing" };
    const body = apiErrorBody("conflict", "raw wire message", presentation);
    assert.deepEqual(body, {
      error: { code: "conflict", message: "raw wire message", presentation },
    });
    assert.deepEqual(parseApiErrorBody(JSON.parse(JSON.stringify(body))), {
      code: "conflict",
      message: "raw wire message",
      presentation,
    });
  });

  it("keeps parsing error bodies without a presentation", () => {
    assert.deepEqual(apiErrorBody("not_found", "missing"), {
      error: { code: "not_found", message: "missing" },
    });
    assert.deepEqual(parseApiErrorBody({ error: { code: "http", message: "m" } }), {
      code: "http",
      message: "m",
    });
  });

  it("drops a malformed presentation instead of rejecting the body", () => {
    assert.deepEqual(
      parseApiErrorBody({ error: { code: "http", message: "m", presentation: "oops" } }),
      { code: "http", message: "m" },
    );
    assert.equal(parseApiErrorBody({ error: { code: 1, message: "m" } }), undefined);
    assert.equal(parseApiErrorBody("nope"), undefined);
  });

  it("carries the presentation on SashApiError", () => {
    const error = new SashApiError(409, "conflict", "raw", {
      message: "friendly",
      advice: "act",
    });
    assert.equal(error.message, "raw");
    assert.deepEqual(error.presentation, { message: "friendly", advice: "act" });
    assert.deepEqual(errorPresentation(error), { message: "friendly", advice: "act" });
    const bare = new SashApiError(500, undefined, "raw");
    assert.equal(bare.presentation, undefined);
    assert.equal(errorPresentation(bare), undefined);
  });
});
