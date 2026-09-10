import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseApiErrorBody,
  parseDaemonStatus,
  parseHealthInfo,
  parseProfilesIndex,
} from "./contracts.js";
import { testProfile, testStatus } from "./testing/state.js";

describe("shared API boundaries", () => {
  it("validates boot identity and projects only public status fields", () => {
    const status = testStatus();
    const parsed = parseDaemonStatus({
      ...status,
      extra: true,
      settings: { ...status.settings, secret: "private", daemonSecret: "private" },
    });
    assert.deepEqual(parsed, status);
    assert.deepEqual(
      parseHealthInfo({ token: "boot", pid: 1, startedAt: status.daemon.startedAt, extra: true }),
      { token: "boot", pid: 1, startedAt: status.daemon.startedAt },
    );
    for (const patch of [{ pid: 0 }, { pid: 1.5 }, { token: " " }, { startedAt: "yesterday" }])
      assert.throws(() =>
        parseHealthInfo({ token: "boot", pid: 1, startedAt: status.daemon.startedAt, ...patch }),
      );
    assert.deepEqual(parseApiErrorBody({ error: { code: "conflict", message: "changed" } }), {
      code: "conflict",
      message: "changed",
    });
    assert.equal(parseApiErrorBody("invalid"), undefined);
    assert.equal(
      parseProfilesIndex({ activeId: null, profiles: [testProfile()] }).profiles[0]?.revision,
      1,
    );
    assert.throws(() =>
      parseProfilesIndex({ activeId: null, profiles: [{ ...testProfile(), revision: 0 }] }),
    );
  });
  it("rejects malformed status and missing observation flags", () => {
    const status = testStatus();
    for (const value of [
      null,
      {},
      { ...status, daemon: { ...status.daemon, bootId: "" } },
      { ...status, revisions: { state: 0, runtime: -1 } },
      { ...status, core: { running: "true" } },
      { ...status, configuration: {} },
      { ...status, systemProxy: { desired: false, applied: false } },
      { ...status, settings: { ...status.settings, mixedPort: 65536 } },
    ])
      assert.throws(() => parseDaemonStatus(value));
  });
});
