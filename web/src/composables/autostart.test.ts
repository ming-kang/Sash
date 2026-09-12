import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectScope, nextTick, ref } from "vue";
import type { AutostartStatus } from "../../../src/autostart/contract.js";
import { api } from "../api/index.js";
import { useAutostart } from "./autostart.js";

const off: AutostartStatus = { state: "off", canEnable: true, reason: null };
const on: AutostartStatus = { ...off, state: "on" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("autostart UI observations", () => {
  it("waits for a committed response and prevents overlapping switches", async (t) => {
    t.mock.method(api, "getAutostart", async () => off);
    const mutation = deferred<AutostartStatus>();
    const setter = t.mock.method(api, "setAutostart", () => mutation.promise);
    const scope = effectScope();
    t.after(() => scope.stop());
    const control = scope.run(() => useAutostart(ref("daemon-a")));
    assert.ok(control);
    await nextTick();
    assert.equal(control.status.value?.state, "off");
    const saving = control.setEnabled(true);
    assert.equal(control.status.value?.state, "off");
    assert.equal(control.busy.value, true);
    assert.equal(await control.setEnabled(false), false);
    assert.equal(setter.mock.callCount(), 1);
    mutation.resolve(on);
    assert.equal(await saving, true);
    assert.equal(control.status.value?.state, "on");
    assert.equal(control.busy.value, false);
  });

  it("discards a slow response from an earlier daemon and never fetches while disconnected", async (t) => {
    const old = deferred<AutostartStatus>();
    let reads = 0;
    t.mock.method(api, "getAutostart", () => (++reads === 1 ? old.promise : Promise.resolve(off)));
    const scope = effectScope();
    t.after(() => scope.stop());
    const owner = ref<string | null>(null);
    const control = scope.run(() => useAutostart(owner));
    assert.ok(control);
    await nextTick();
    assert.equal(reads, 0);
    owner.value = "old";
    owner.value = "new";
    await nextTick();
    old.resolve(on);
    await nextTick();
    assert.equal(control.status.value?.state, "off");
    owner.value = null;
    assert.equal(control.status.value, null);
    assert.equal(await control.setEnabled(true), false);
    assert.equal(reads, 2);
  });

  it("re-reads a partial write after an HTTP failure instead of reverting to a guessed state", async (t) => {
    let reads = 0;
    t.mock.method(api, "getAutostart", async () => (++reads === 1 ? off : on));
    const failure = new Error("response lost");
    t.mock.method(api, "setAutostart", async () => {
      throw failure;
    });
    const scope = effectScope();
    t.after(() => scope.stop());
    const control = scope.run(() => useAutostart(ref("daemon")));
    assert.ok(control);
    await nextTick();
    await assert.rejects(control.setEnabled(true), (error) => error === failure);
    assert.equal(control.status.value?.state, "on");
    assert.equal(control.busy.value, false);
  });

  it("does not adopt a late successful mutation after the view is disposed", async (t) => {
    t.mock.method(api, "getAutostart", async () => off);
    const mutation = deferred<AutostartStatus>();
    t.mock.method(api, "setAutostart", () => mutation.promise);
    const scope = effectScope();
    const control = scope.run(() => useAutostart(ref("daemon")));
    assert.ok(control);
    await nextTick();
    const saving = control.setEnabled(true);
    scope.stop();
    mutation.resolve(on);
    assert.equal(await saving, false);
    assert.equal(control.status.value?.state, "off");
  });
});
