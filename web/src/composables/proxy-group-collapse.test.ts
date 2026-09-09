import assert from "node:assert/strict";
import { it } from "node:test";
import { shallowRef } from "vue";
import { useProxyGroupCollapse } from "./proxy-group-collapse.js";

it("remembers explicit expanded and collapsed choices while defaulting only excess groups", (t) => {
  let saved = "{}";
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const groups = shallowRef(["a", "b", "c", "d", "e", "GLOBAL"]);
  const initial = useProxyGroupCollapse(groups);
  assert.deepEqual([...initial.collapsedGroups.value], ["e"]);
  initial.toggleCollapse("e");
  initial.toggleCollapse("a");
  assert.deepEqual([...useProxyGroupCollapse(groups).collapsedGroups.value], ["a"]);
  groups.value = ["e", "b", "c", "d", "a", "f", "GLOBAL"];
  assert.deepEqual([...initial.collapsedGroups.value], ["a", "f"]);
  saved = "not json";
  assert.deepEqual([...useProxyGroupCollapse(groups).collapsedGroups.value], ["a", "f"]);
});
