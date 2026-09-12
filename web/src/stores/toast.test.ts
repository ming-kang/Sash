import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { store } from "./state.js";
import { dismissToast, pushToast, setToastPaused, toast } from "./toast.js";

afterEach(() => {
  for (const item of store.toasts) dismissToast(item.id);
});

it("keeps errors until dismissed and pauses normal toast expiry for both pointer and focus", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  pushToast("error", "A useful error");
  pushToast("success", "Saved");
  const item = store.toasts[1];
  assert.ok(item);
  assert.ok(item.duration > 0);
  t.mock.timers.tick(2000);
  setToastPaused(item.id, "pointer", true);
  setToastPaused(item.id, "focus", true);
  t.mock.timers.tick(10_000);
  setToastPaused(item.id, "pointer", false);
  t.mock.timers.tick(10_000);
  assert.equal(store.toasts.length, 2);
  setToastPaused(item.id, "focus", false);
  t.mock.timers.tick(item.duration - 2001);
  assert.equal(store.toasts.length, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(
    store.toasts.map((entry) => entry.text),
    ["A useful error"],
  );
  t.mock.timers.tick(60_000);
  assert.equal(store.toasts.length, 1);
});

it("folds identical toasts into a repeat counter and re-arms the timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  toast.success("Saved");
  t.mock.timers.tick(1000);
  toast.success("Saved");
  t.mock.timers.tick(1000);
  toast.success("Saved");
  assert.equal(store.toasts.length, 1);
  assert.equal(store.toasts[0]?.count, 3);
  const duration = store.toasts[0]?.duration ?? 0;
  assert.ok(duration > 0);
  // The last push re-armed the full duration at t=2000.
  t.mock.timers.tick(duration - 1);
  assert.equal(store.toasts.length, 1);
  t.mock.timers.tick(1);
  assert.equal(store.toasts.length, 0);
});

it("caps visible toasts, evicting the oldest dismissible one first", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  toast.error("pinned failure");
  for (let i = 1; i <= 6; i += 1) toast.success(`saved ${i}`);
  assert.equal(store.toasts.length, 5);
  assert.deepEqual(
    store.toasts.map((item) => item.text),
    ["pinned failure", "saved 3", "saved 4", "saved 5", "saved 6"],
  );
});

it("auto-dismisses warnings", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  toast.warning("3 nodes timed out");
  const item = store.toasts[0];
  assert.ok(item);
  assert.equal(item.kind, "warning");
  assert.ok(item.duration > 0);
  t.mock.timers.tick(item.duration);
  assert.equal(store.toasts.length, 0);
});
