import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errnoCode, errorMessage } from "./error-utils.js";

describe("error helpers", () => {
  it("normalizes Error and non-Error messages", () => {
    assert.equal(errorMessage(new Error("boom")), "boom");
    assert.equal(errorMessage("failed"), "failed");
    assert.equal(errorMessage(42), "42");
  });

  it("reads only string errno codes without masking unknown throws", () => {
    assert.equal(errnoCode(Object.assign(new Error("missing"), { code: "ENOENT" })), "ENOENT");
    const throwingCode = Object.defineProperty(new Error("original"), "code", {
      get() {
        throw new Error("code getter failed");
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    for (const value of [
      new Error("plain"),
      null,
      undefined,
      "failure",
      { code: 7 },
      throwingCode,
      revoked.proxy,
    ]) {
      assert.equal(errnoCode(value), undefined);
    }
  });
});
