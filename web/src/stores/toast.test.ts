import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { store } from "./state.js";
import { dismissToast, pushToast, setToastPaused } from "./toast.js";

afterEach(() => {
  for (const toast of store.toasts) dismissToast(toast.id);
});

it("keeps errors until dismissed and pauses normal toast expiry for both pointer and focus", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  pushToast("error", "A useful error");
  pushToast("success", "Saved");
  const id = store.toasts[1]?.id;
  assert.ok(id);
  t.mock.timers.tick(2000);
  setToastPaused(id, "pointer", true);
  setToastPaused(id, "focus", true);
  t.mock.timers.tick(10_000);
  setToastPaused(id, "pointer", false);
  t.mock.timers.tick(10_000);
  assert.equal(store.toasts.length, 2);
  setToastPaused(id, "focus", false);
  t.mock.timers.tick(2199);
  assert.equal(store.toasts.length, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(
    store.toasts.map((item) => item.text),
    ["A useful error"],
  );
  t.mock.timers.tick(60_000);
  assert.equal(store.toasts.length, 1);
});
