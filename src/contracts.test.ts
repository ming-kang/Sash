import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  apiErrorBody,
  type DaemonStatus,
  parseApiErrorBody,
  parseTunHelperAuth,
  SashApiError,
  tunApplyState,
} from "./contracts.js";
import { errorPresentation } from "./error-utils.js";
import { testStatus } from "./testing/state.js";
import { defaultTunSettings } from "./tun-settings.js";

describe("tunApplyState", () => {
  function status(
    saved: boolean,
    running: { enable: boolean } | "stopped",
    tunPending = false,
  ): DaemonStatus {
    const base = testStatus();
    return {
      ...base,
      core: running === "stopped" ? { running: false } : base.core,
      settings: { ...base.settings, tun: { ...defaultTunSettings(), enable: saved } },
      configuration: {
        ...base.configuration,
        pendingChanges: { ...base.configuration.pendingChanges, tun: tunPending },
        appliedSettings: {
          mixedPort: base.settings.mixedPort,
          allowLan: base.settings.allowLan,
          tun: { ...defaultTunSettings(), enable: running !== "stopped" && running.enable },
        },
      },
    };
  }

  it("is settled when the running Core uses the saved TUN settings", () => {
    assert.deepEqual(tunApplyState(status(true, { enable: true })), {
      desired: true,
      applied: true,
      pending: false,
    });
    assert.deepEqual(tunApplyState(status(false, { enable: false })), {
      desired: false,
      applied: false,
      pending: false,
    });
  });

  it("is pending while the enable switch or an effective setting waits for Apply", () => {
    assert.equal(tunApplyState(status(true, { enable: false }, true)).pending, true);
    assert.equal(tunApplyState(status(false, { enable: true }, true)).applied, true);
    assert.deepEqual(tunApplyState(status(true, { enable: true }, true)), {
      desired: true,
      applied: true,
      pending: true,
    });
  });

  it("never reports TUN applied while Core is stopped", () => {
    const stopped = status(true, "stopped");
    stopped.configuration.appliedSettings = {
      mixedPort: stopped.settings.mixedPort,
      allowLan: stopped.settings.allowLan,
      tun: { ...defaultTunSettings(), enable: true },
    };
    assert.deepEqual(tunApplyState(stopped), { desired: true, applied: false, pending: true });
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
