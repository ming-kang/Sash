import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  apiErrorBody,
  parseApiErrorBody,
  parseTunHelperAuth,
  SashApiError,
  tunApplyState,
  tunApplyStateFor,
  tunPending,
} from "./contracts.js";
import { errorPresentation } from "./error-utils.js";
import { testStatus } from "./testing/state.js";
import { defaultTunSettings, type TunSettings } from "./tun-settings.js";

describe("TUN apply state", () => {
  function tun(patch: Partial<TunSettings> = {}): TunSettings {
    return { ...defaultTunSettings(), ...patch };
  }

  it("is settled while the applied TUN settings match the saved ones", () => {
    assert.deepEqual(tunApplyStateFor(tun({ enable: true }), tun({ enable: true })), {
      desired: true,
      applied: true,
      pending: false,
    });
    assert.deepEqual(tunApplyStateFor(tun(), tun()), {
      desired: false,
      applied: false,
      pending: false,
    });
  });

  it("ignores advanced fields while TUN stays disabled on both sides", () => {
    assert.equal(tunPending(tun({ stack: "gvisor", strictRoute: true }), tun()), false);
    assert.equal(tunPending(tun(), tun({ dnsHijack: ["any:53"] })), false);
  });

  it("is pending until an enabled setting or an effective edit is applied", () => {
    assert.deepEqual(tunApplyStateFor(tun({ enable: true })), {
      desired: true,
      applied: false,
      pending: true,
    });
    assert.equal(tunPending(tun(), tun({ enable: true })), true);
    assert.equal(
      tunPending(tun({ enable: true, dnsHijack: ["any:53"] }), tun({ enable: true })),
      true,
    );
    assert.equal(tunPending(tun({ enable: true }), tun({ enable: true })), false);
  });

  it("reads the apply state the daemon derived from its runtime", () => {
    const status = testStatus();
    status.configuration.tunApply = { desired: true, applied: false, pending: true };
    assert.deepEqual(tunApplyState(status), {
      desired: true,
      applied: false,
      pending: true,
    });
  });
});

describe("parseTunHelperAuth", () => {
  it("accepts exactly the two mechanisms and ignores anything else", () => {
    assert.equal(parseTunHelperAuth("sudo"), "sudo");
    assert.equal(parseTunHelperAuth("pkexec"), "pkexec");
    for (const invalid of ["yes", "Sudo", "", undefined, null, 1, {}])
      assert.equal(parseTunHelperAuth(invalid), undefined);
  });
});

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
