import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDaemonStatus, parseHealthInfo, parseSystemProxyStatusResponse } from "./contracts.js";

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

describe("daemon response contracts", () => {
  it("parses and projects a canonical health response", () => {
    assert.deepEqual(
      parseHealthInfo({
        ok: true,
        token: "boot-token",
        pid: 1234,
        startedAt: timestamp,
        futureField: "ignored",
      }),
      { ok: true, token: "boot-token", pid: 1234, startedAt: timestamp },
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
      const document = { ok: true, token: "token", pid: 1, startedAt: timestamp, [field]: value };
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
});
