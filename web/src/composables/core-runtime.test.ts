import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { testStatus } from "../../../src/testing/state.js";
import { setLocale } from "../i18n/index.js";
import { markDaemonOffline } from "../stores/runtime-actions.js";
import { adoptDaemonStatus } from "../stores/state.js";
import { coreApplyActionLabel, coreApplyTooltip, coreUpdateText } from "./core-runtime.js";

describe("core update progress text", () => {
  afterEach(() => {
    markDaemonOffline();
    setLocale("zh");
  });

  it("renders the localized stage, bytes and note", () => {
    setLocale("en");
    adoptDaemonStatus({
      ...testStatus(),
      coreUpdate: {
        stage: "downloading",
        startedAt: "2026-09-15T00:00:00.000Z",
        target: "v2.0.0",
        downloading: true,
        downloaded: 1048576,
        total: 2097152,
        note: "proxy 127.0.0.1:7890 refused connection — retrying without proxy",
      },
    });
    assert.equal(
      coreUpdateText.value,
      "Downloading Core (v2.0.0): 1.0 / 2.0 MiB · proxy 127.0.0.1:7890 refused connection — retrying without proxy",
    );
  });

  it("renders the zh stage and hides when no update runs", () => {
    setLocale("zh");
    adoptDaemonStatus({
      ...testStatus(),
      coreUpdate: {
        stage: "validating",
        startedAt: "2026-09-15T00:00:00.000Z",
        target: null,
        downloading: false,
        downloaded: 0,
        total: null,
      },
    });
    assert.equal(coreUpdateText.value, "正在检查配置");
    adoptDaemonStatus({ ...testStatus(), coreUpdate: null });
    assert.equal(coreUpdateText.value, "");
  });
});

describe("core apply copy", () => {
  afterEach(() => {
    markDaemonOffline();
    setLocale("zh");
  });

  type Configuration = ReturnType<typeof testStatus>["configuration"];
  function statusWith(
    configuration: Omit<Partial<Configuration>, "pendingChanges"> & {
      pendingChanges?: Partial<Configuration["pendingChanges"]>;
    },
  ): ReturnType<typeof testStatus> {
    const status = testStatus();
    return {
      ...status,
      configuration: {
        ...status.configuration,
        ...configuration,
        pendingChanges: {
          ...status.configuration.pendingChanges,
          ...configuration.pendingChanges,
        },
      },
    };
  }

  it("names TUN and the restart cost in zh", () => {
    setLocale("zh");
    adoptDaemonStatus(
      statusWith({
        pending: true,
        applyMethod: "restart",
        pendingChanges: { tun: true },
      }),
    );
    assert.equal(
      coreApplyTooltip.value,
      "待应用的更改：TUN 模式；应用时会重启核心，活动连接将中断",
    );
    assert.equal(coreApplyActionLabel.value, "重启并应用");
  });

  it("describes profile-only pending as an in-place reload in en", () => {
    setLocale("en");
    adoptDaemonStatus(
      statusWith({
        pending: true,
        applyMethod: "reload",
        pendingChanges: { profile: true },
      }),
    );
    assert.equal(
      coreApplyTooltip.value,
      "Pending changes: profile. The Core reloads in place; active connections are kept",
    );
    assert.equal(coreApplyActionLabel.value, "Reload configuration");
  });

  it("formats multiple pending causes in a stable localized list", () => {
    setLocale("en");
    adoptDaemonStatus(
      statusWith({
        pending: true,
        applyMethod: "restart",
        pendingChanges: { profile: true, mixedPort: true, tun: true },
      }),
    );
    assert.equal(
      coreApplyTooltip.value,
      "Pending changes: profile, proxy port, and TUN Mode. Applying restarts the Core; active connections drop",
    );
  });

  it("does not blame profile changes when degraded Core health forces a restart", () => {
    adoptDaemonStatus(
      statusWith({
        pending: true,
        applyMethod: "restart",
        pendingChanges: { profile: true },
      }),
    );
    assert.equal(coreApplyTooltip.value, "应用时会重启核心，活动连接将中断");
  });

  it("uses manual reload copy when nothing is pending", () => {
    adoptDaemonStatus(statusWith({ pending: false, applyMethod: "reload" }));
    assert.equal(coreApplyTooltip.value, "重载当前配置；核心原位重载，活动连接会保持");
  });

  it("explains an unknown runtime conservatively", () => {
    adoptDaemonStatus(
      statusWith({
        pending: true,
        applyMethod: "restart",
        pendingChanges: { runtimeUnknown: true },
      }),
    );
    assert.equal(coreApplyTooltip.value, "无法确认当前运行配置；应用时会重启核心，活动连接将中断");
  });

  it("falls back to cautious copy for a daemon without structured pending state", () => {
    const legacy = testStatus();
    const configuration = legacy.configuration as unknown as Record<string, unknown>;
    delete configuration.pendingChanges;
    delete configuration.applyMethod;
    adoptDaemonStatus(legacy);
    assert.equal(coreApplyTooltip.value, "应用保存的配置；部分变更会重启核心并中断活动连接");
  });
});
