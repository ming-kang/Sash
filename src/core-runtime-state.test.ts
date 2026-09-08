import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureCoreRuntimeState, parseCoreRuntimeState } from "./core-runtime-state.js";

describe("Core runtime snapshot", () => {
  it("keeps prototype-like selector names as data and leaves automatic policies alone", () => {
    const state = captureCoreRuntimeState(
      { mode: "global" },
      {
        proxies: Object.fromEntries([
          ["__proto__", { type: "Selector", now: "node / 中文" }],
          ["Auto", { type: "URLTest", now: "different node" }],
        ]),
      },
    );
    assert.equal(Object.hasOwn(state.selections, "__proto__"), true);
    assert.equal(
      Object.getOwnPropertyDescriptor(state.selections, "__proto__")?.value,
      "node / 中文",
    );
    assert.deepEqual(Object.keys(state.selections), ["__proto__"]);
    assert.equal(state.mode, "global");
  });
  it("rejects malformed modes, selections and unbounded snapshots", () => {
    for (const state of [
      null,
      {},
      { mode: "TUN", selections: {} },
      { mode: "rule", selections: { group: null } },
      { mode: "rule", selections: { group: "" } },
      {
        mode: "rule",
        selections: Object.fromEntries(
          Array.from({ length: 10_001 }, (_, i) => [String(i), "DIRECT"]),
        ),
      },
    ])
      assert.throws(() => parseCoreRuntimeState(state));
    assert.throws(() =>
      captureCoreRuntimeState({ mode: "rule" }, { proxies: { group: { type: "Selector" } } }),
    );
  });
});
