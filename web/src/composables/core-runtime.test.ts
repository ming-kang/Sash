import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { testStatus } from "../../../src/testing/state.js";
import { setLocale } from "../i18n/index.js";
import { markDaemonOffline } from "../stores/runtime-actions.js";
import { adoptDaemonStatus } from "../stores/state.js";
import { coreUpdateText } from "./core-runtime.js";

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
    assert.equal(coreUpdateText.value, "正在验证运行配置");
    adoptDaemonStatus({ ...testStatus(), coreUpdate: null });
    assert.equal(coreUpdateText.value, "");
  });
});
