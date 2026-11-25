import assert from "node:assert/strict";
import { afterEach, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";
import { testStatus } from "../../../src/testing/state.js";
import { setLocale } from "../i18n/index.js";
import { markDaemonOffline } from "../stores/runtime-actions.js";
import { adoptDaemonStatus } from "../stores/state.js";
import { useCoreUptime } from "./core-uptime.js";

afterEach(() => {
  markDaemonOffline();
  setLocale("zh");
});

it("advances without a status refresh and follows Core stops and starts", async () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 59);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now });
  setLocale("en");
  adoptDaemonStatus({
    ...testStatus(),
    core: {
      ...testStatus().core,
      startedAt: new Date(now - 59_000).toISOString(),
    },
  });
  const scope = effectScope();
  const uptime = scope.run(() => useCoreUptime());
  assert.ok(uptime);
  assert.equal(uptime.value, "00:00:59");

  vi.advanceTimersByTime(1000);
  assert.equal(uptime.value, "00:01:00");

  adoptDaemonStatus({ ...testStatus(), core: { running: false } });
  await nextTick();
  assert.equal(uptime.value, "--:--:--");

  vi.advanceTimersByTime(60_000);
  adoptDaemonStatus({
    ...testStatus(),
    core: { ...testStatus().core, startedAt: new Date(Date.now()).toISOString() },
  });
  await nextTick();
  assert.equal(uptime.value, "00:00:00");
  vi.advanceTimersByTime(1000);
  assert.equal(uptime.value, "00:00:01");
  scope.stop();
});
