import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseApiErrorBody,
  parseCoreStartResult,
  parseCoreUpdateResponse,
  parseDaemonStatus,
  parseHealthInfo,
  parseProfileActionResponse,
  parseProfileContentResponse,
  parseProfilesIndex,
  parseProfilesUpdateAllResponse,
  parseSettingsPatch,
  parseSettingsWriteResult,
  parseSystemProxyStatusResponse,
} from "./contracts.js";
import { testProfile, testStatus } from "./test-state.test.js";

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
  });
  it("rejects malformed status and missing observation flags", () => {
    const status = testStatus();
    for (const value of [
      null,
      {},
      { ...status, daemon: { ...status.daemon, bootId: "" } },
      { ...status, revisions: { profiles: 0, runtime: -1 } },
      { ...status, core: { running: "true" } },
      { ...status, configuration: {} },
      { ...status, systemProxy: { desired: false, applied: false } },
      { ...status, settings: { ...status.settings, mixedPort: 65536 } },
    ])
      assert.throws(() => parseDaemonStatus(value));
  });
  it("requires current proxy flags instead of guessing absent values", () => {
    const value = {
      supported: true,
      enabled: false,
      desired: false,
      applied: false,
      appliedKnown: false,
      stateKnown: false,
    };
    assert.deepEqual(parseSystemProxyStatusResponse(value), value);
    assert.throws(() => parseSystemProxyStatusResponse({ ...value, stateKnown: undefined }));
  });
  it("validates lifecycle and saved-settings results", () => {
    assert.deepEqual(parseCoreStartResult({ pid: 1234, version: "v1" }), {
      pid: 1234,
      version: "v1",
    });
    assert.throws(() => parseCoreStartResult({ pid: -1 }));
    assert.deepEqual(parseCoreUpdateResponse({ version: "v2" }), { version: "v2" });
    assert.throws(() => parseCoreUpdateResponse({ version: "" }));
    assert.equal(
      parseSettingsWriteResult({ restartRequired: true, settings: testStatus().settings })
        .restartRequired,
      true,
    );
    assert.deepEqual(parseSettingsPatch({ mixedPort: 18880, allowLan: true }), {
      mixedPort: 18880,
      allowLan: true,
    });
    for (const value of [
      { tun: false },
      { daemonPort: 19090 },
      { secret: "secret" },
      { mixedPort: 0 },
    ])
      assert.throws(() => parseSettingsPatch(value));
  });
  it("validates profile revisions and per-profile error bodies", () => {
    const profile = testProfile();
    assert.equal(
      parseProfilesIndex({ activeId: profile.id, profiles: [profile] }).profiles[0]?.revision,
      1,
    );
    assert.deepEqual(parseProfileActionResponse({ profile, activated: true }), {
      profile,
      activated: true,
    });
    assert.throws(() => parseProfileContentResponse({ name: "name", content: "rules: []" }));
    assert.equal(
      parseProfileContentResponse({ name: "name", content: "rules: []", revision: 1 }).revision,
      1,
    );
    assert.throws(() =>
      parseProfilesIndex({ activeId: null, profiles: [{ ...profile, revision: 0 }] }),
    );
    assert.equal(
      parseProfilesUpdateAllResponse({
        updated: 1,
        failed: [{ id: "2", name: "remote", error: "offline" }],
      }).failed.length,
      1,
    );
    assert.throws(() => parseProfilesUpdateAllResponse({ updated: 1, failed: [{}] }));
    assert.deepEqual(parseApiErrorBody({ error: { code: "conflict", message: "changed" } }), {
      code: "conflict",
      message: "changed",
    });
    assert.equal(parseApiErrorBody("invalid"), undefined);
  });
});
