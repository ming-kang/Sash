import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseApiErrorBody,
  parseCoreReloadResult,
  parseCoreStartResult,
  parseDaemonStatus,
  parseHealthInfo,
  parseProfileActionResponse,
  parseProfilesIndex,
  parseProfilesUpdateAllResponse,
  parseSettingsPatch,
  parseSettingsWriteResult,
  parseShutdownResult,
  parseSystemProxyStatusResponse,
} from "./contracts.js";

const timestamp = "2026-01-02T03:04:05.000Z";

function statusDocument(): Record<string, unknown> {
  return {
    daemon: { pid: 1234, startedAt: timestamp, port: 19090 },
    revisions: { profiles: 2 },
    core: {
      running: true,
      pid: 4321,
      startedAt: timestamp,
      healthy: true,
      version: "v1.2.3",
      tunActive: false,
    },
    systemProxy: {
      desired: true,
      applied: true,
      actual: { supported: true, enabled: true, server: "127.0.0.1:17890" },
      appliedKnown: true,
      stateKnown: true,
    },
    settings: {
      mixedPort: 17890,
      controller: "127.0.0.1:9090",
      tun: false,
      allowLan: false,
      daemonPort: 19090,
      systemProxy: true,
    },
    activeProfile: { id: "1", name: "local", url: "" },
  };
}

function profileMetaDocument(): Record<string, unknown> {
  return {
    id: "1780811098558",
    name: "edge",
    url: "https://example.com/sub",
    intervalHours: 24,
    createdAt: timestamp,
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

describe("daemon response contracts", () => {
  it("parses and projects a canonical health response", () => {
    assert.deepEqual(
      parseHealthInfo({
        token: "boot-token",
        pid: 1234,
        startedAt: timestamp,
        futureField: "ignored",
      }),
      { token: "boot-token", pid: 1234, startedAt: timestamp },
    );
  });

  it("rejects unsafe health identity fields and non-canonical timestamps", () => {
    for (const [field, value] of [
      ["pid", 0],
      ["pid", 1.5],
      ["pid", Number.MAX_SAFE_INTEGER + 1],
      ["token", "   "],
      ["startedAt", "2026-01-02 03:04:05Z"],
    ] as const) {
      const document = { token: "token", pid: 1, startedAt: timestamp, [field]: value };
      assert.throws(() => parseHealthInfo(document), new RegExp(String(field)));
    }
  });

  it("parses status while dropping unknown fields and control secrets", () => {
    const document = statusDocument();
    document.future = true;
    (document.daemon as Record<string, unknown>).future = true;
    (document.settings as Record<string, unknown>).secret = "must-not-cross-the-boundary";
    (document.settings as Record<string, unknown>).daemonSecret = "must-not-cross-the-boundary";

    const parsed = parseDaemonStatus(document);

    assert.equal(parsed.daemon.pid, 1234);
    assert.equal(parsed.core.version, "v1.2.3");
    assert.equal(parsed.systemProxy.actual?.server, "127.0.0.1:17890");
    assert.equal(parsed.activeProfile?.url, "");
    assert.deepEqual(Object.keys(parsed.settings).sort(), [
      "allowLan",
      "controller",
      "daemonPort",
      "mixedPort",
      "systemProxy",
      "tun",
    ]);
    assert.equal("future" in parsed, false);
    assert.equal("future" in parsed.daemon, false);
  });

  it("normalizes only missing legacy known flags to false", () => {
    const document = statusDocument();
    const proxy = document.systemProxy as Record<string, unknown>;
    delete proxy.appliedKnown;
    delete proxy.stateKnown;

    const parsed = parseDaemonStatus(document);
    assert.equal(parsed.systemProxy.appliedKnown, false);
    assert.equal(parsed.systemProxy.stateKnown, false);

    proxy.appliedKnown = undefined;
    assert.throws(() => parseDaemonStatus(document), /systemProxy\.appliedKnown/);
  });

  it("rejects malformed required status fields", () => {
    const cases: Array<[string, (document: Record<string, unknown>) => void]> = [
      ["daemon", (document) => delete document.daemon],
      ["daemon.port", (document) => ((document.daemon as Record<string, unknown>).port = 0)],
      [
        "daemon.startedAt",
        (document) =>
          ((document.daemon as Record<string, unknown>).startedAt = "2026-01-02T03:04:05Z"),
      ],
      [
        "revisions.profiles",
        (document) => ((document.revisions as Record<string, unknown>).profiles = -1),
      ],
      ["core.running", (document) => ((document.core as Record<string, unknown>).running = "yes")],
      ["core.pid", (document) => ((document.core as Record<string, unknown>).pid = 1.5)],
      [
        "core.startedAt",
        (document) => ((document.core as Record<string, unknown>).startedAt = "yesterday"),
      ],
      [
        "systemProxy.actual.enabled",
        (document) =>
          ((
            (document.systemProxy as Record<string, unknown>).actual as Record<string, unknown>
          ).enabled = 1),
      ],
      [
        "settings.mixedPort",
        (document) => ((document.settings as Record<string, unknown>).mixedPort = 65_536),
      ],
      ["settings.tun", (document) => ((document.settings as Record<string, unknown>).tun = 0)],
      [
        "activeProfile.id",
        (document) => ((document.activeProfile as Record<string, unknown>).id = ""),
      ],
    ];

    for (const [path, mutate] of cases) {
      const document = statusDocument();
      mutate(document);
      assert.throws(() => parseDaemonStatus(document), new RegExp(path.replace(".", "\\.")));
    }
  });

  it("parses the flattened proxy response and supports legacy known flags", () => {
    const parsed = parseSystemProxyStatusResponse({
      desired: false,
      applied: false,
      supported: true,
      enabled: false,
      details: "off",
      future: "ignored",
    });

    assert.deepEqual(parsed, {
      desired: false,
      applied: false,
      supported: true,
      enabled: false,
      details: "off",
      appliedKnown: false,
      stateKnown: false,
    });
    assert.throws(
      () =>
        parseSystemProxyStatusResponse({
          desired: false,
          applied: false,
          supported: true,
          enabled: false,
          stateKnown: "yes",
        }),
      /stateKnown/,
    );
  });

  it("parses core lifecycle results without an ok envelope", () => {
    assert.deepEqual(parseCoreStartResult({ pid: 4321, version: "v1.2.3", tunActive: true }), {
      pid: 4321,
      version: "v1.2.3",
      tunActive: true,
    });
    assert.deepEqual(parseCoreStartResult({ pid: 4321 }), { pid: 4321 });
    assert.throws(() => parseCoreStartResult({ pid: -1 }), /pid/);

    assert.deepEqual(parseCoreReloadResult({ proxyCount: 12, source: "subscription" }), {
      proxyCount: 12,
      source: "subscription",
    });
    assert.throws(() => parseCoreReloadResult({ proxyCount: 12, source: "other" }), /source/);

    assert.deepEqual(parseShutdownResult({ coreWasRunning: false }), { coreWasRunning: false });
    assert.throws(() => parseShutdownResult({}), /coreWasRunning/);
  });

  it("parses the settings patch protocol strictly", () => {
    assert.deepEqual(
      parseSettingsPatch({
        mixedPort: 17891,
        allowLan: true,
        tun: false,
        systemProxy: true,
        daemonPort: 19091,
        daemonSecret: "new-secret",
      }),
      {
        mixedPort: 17891,
        allowLan: true,
        tun: false,
        systemProxy: true,
        daemonPort: 19091,
        daemonSecret: "new-secret",
      },
    );
    assert.deepEqual(parseSettingsPatch({}), {});
    assert.throws(() => parseSettingsPatch({ secret: "core-secret" }), /secret/);
    assert.throws(() => parseSettingsPatch({ mixedPort: 0 }), /mixedPort/);
    assert.throws(() => parseSettingsPatch({ tun: "on" }), /tun/);
    assert.throws(() => parseSettingsPatch({ daemonSecret: "  " }), /daemonSecret/);
  });

  it("parses settings write results and file content", () => {
    const parsed = parseSettingsWriteResult({
      restartRequired: true,
      settings: {
        mixedPort: 17890,
        controller: "127.0.0.1:9090",
        tun: false,
        allowLan: false,
        daemonPort: 19091,
        systemProxy: false,
      },
    });
    assert.equal(parsed.restartRequired, true);
    assert.equal(parsed.settings.daemonPort, 19091);
    assert.throws(() => parseSettingsWriteResult({ restartRequired: true }), /settings/);
  });

  it("parses profile responses with full metadata validation", () => {
    const index = parseProfilesIndex({
      activeId: "1780811098558",
      profiles: [
        {
          ...profileMetaDocument(),
          subInfo: { upload: 1, download: 2, total: 3, expire: 4 },
          homePage: "https://example.com",
          lastError: "boom",
        },
      ],
    });
    assert.equal(index.activeId, "1780811098558");
    assert.equal(index.profiles[0]?.subInfo?.total, 3);
    assert.equal(index.profiles[0]?.lastError, "boom");

    assert.deepEqual(parseProfilesIndex({ activeId: null, profiles: [] }), {
      activeId: null,
      profiles: [],
    });
    assert.throws(() => parseProfilesIndex({ activeId: null, profiles: [{}] }), /profiles\[0\]/);

    const action = parseProfileActionResponse({
      profile: profileMetaDocument(),
      activated: true,
      proxyCount: 7,
    });
    assert.equal(action.profile.id, "1780811098558");
    assert.equal(action.proxyCount, 7);

    const all = parseProfilesUpdateAllResponse({
      updated: 2,
      failed: [{ id: "1", name: "edge", error: "fetch failed" }],
    });
    assert.equal(all.failed[0]?.error, "fetch failed");
    assert.throws(
      () => parseProfilesUpdateAllResponse({ updated: 2, failed: [{ id: "1" }] }),
      /failed\[0\]/,
    );
  });

  it("extracts structured error envelopes", () => {
    assert.deepEqual(parseApiErrorBody({ error: { code: "conflict", message: "busy" } }), {
      code: "conflict",
      message: "busy",
    });
    assert.equal(parseApiErrorBody({ error: "plain string" }), undefined);
    assert.equal(parseApiErrorBody({}), undefined);
    assert.equal(parseApiErrorBody("nope"), undefined);
  });
});
