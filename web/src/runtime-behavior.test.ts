import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Window as HappyWindow } from "happy-dom";
import { testStatus as healthyStatus } from "../../src/testing/state.js";

describe("minimal Vue behavior harness", () => {
  it("renders reactive daemon and Core snapshot notice transitions", async () => {
    const window = new HappyWindow({ url: "http://127.0.0.1:19090/ui/" });
    const globalKeys = [
      "window",
      "document",
      "navigator",
      "Node",
      "Text",
      "Comment",
      "Element",
      "HTMLElement",
      "SVGElement",
      "Event",
      "CustomEvent",
    ] as const;
    const previous = new Map<string, { existed: boolean; value: unknown }>();
    for (const key of globalKeys) {
      previous.set(key, {
        existed: Object.hasOwn(globalThis, key),
        value: Reflect.get(globalThis, key),
      });
      Reflect.set(globalThis, key, Reflect.get(window, key));
    }

    const { createApp, defineComponent, h, nextTick } = await import("vue");
    const { runtimeNotice, store } = await import("./stores/index.js");
    const original = {
      status: store.status,
      daemonOnline: store.daemonOnline,
      resourceLoaded: store.resourceLoaded,
      resourceErrors: store.resourceErrors,
    };
    const host = window.document.createElement("div");
    window.document.body.append(host);
    const app = createApp(
      defineComponent({
        setup: () => () =>
          h("div", { "data-notice": runtimeNotice.value ?? "none" }, runtimeNotice.value ?? "none"),
      }),
    );

    try {
      app.mount(host as unknown as Element);
      assert.equal(host.textContent, "none");

      store.daemonOnline = false;
      await nextTick();
      assert.equal(host.textContent, "offline");

      store.status = healthyStatus();
      store.daemonOnline = true;
      store.resourceLoaded = {};
      store.resourceErrors = { configs: "HTTP 502" };
      await nextTick();
      assert.equal(host.textContent, "coreUnavailable");

      store.resourceLoaded = { configs: true };
      await nextTick();
      assert.equal(host.textContent, "coreDegraded");

      store.resourceErrors = {};
      await nextTick();
      assert.equal(host.textContent, "none");
    } finally {
      app.unmount();
      store.status = original.status;
      store.daemonOnline = original.daemonOnline;
      store.resourceLoaded = original.resourceLoaded;
      store.resourceErrors = original.resourceErrors;
      await window.close();
      for (const key of globalKeys) {
        const saved = previous.get(key);
        if (saved?.existed) Reflect.set(globalThis, key, saved.value);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});
