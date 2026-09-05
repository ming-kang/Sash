import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Window as HappyWindow } from "happy-dom";
import type { SashStatus } from "./types/index.js";

function healthyStatus(): SashStatus {
  return {
    daemon: { pid: 100, startedAt: "2026-01-01T00:00:00.000Z", port: 19090 },
    revisions: { profiles: 0 },
    core: {
      running: true,
      healthy: true,
      pid: 200,
      startedAt: "2026-01-01T00:00:01.000Z",
    },
    systemProxy: {
      desired: false,
      applied: false,
      actual: { supported: true, enabled: false },
      appliedKnown: true,
      stateKnown: true,
    },
    settings: {
      mixedPort: 17890,
      controller: "127.0.0.1:9090",
      tun: false,
      allowLan: false,
      daemonPort: 19090,
      systemProxy: false,
    },
    activeProfile: null,
  };
}

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
    const { tunStatusBadge } = await import("./composables/core-runtime.js");
    const { t } = await import("./i18n/index.js");
    const original = {
      status: store.status,
      daemonOnline: store.daemonOnline,
      coreSnapshotAvailable: store.coreSnapshotAvailable,
      coreSnapshotError: store.coreSnapshotError,
    };
    const host = window.document.createElement("div");
    window.document.body.append(host);
    const app = createApp(
      defineComponent({
        setup: () => () =>
          h("div", [
            h(
              "div",
              { "data-notice": runtimeNotice.value ?? "none" },
              runtimeNotice.value ?? "none",
            ),
            h(
              "button",
              { "aria-pressed": store.status?.settings.tun ?? false },
              tunStatusBadge.value?.text ?? "off",
            ),
          ]),
      }),
    );

    try {
      app.mount(host as unknown as Element);
      assert.equal(host.querySelector("[data-notice]")?.textContent, "none");

      store.daemonOnline = false;
      await nextTick();
      assert.equal(host.querySelector("[data-notice]")?.textContent, "offline");

      store.status = healthyStatus();
      store.daemonOnline = true;
      store.coreSnapshotAvailable = false;
      store.coreSnapshotError = "HTTP 502";
      await nextTick();
      assert.equal(host.querySelector("[data-notice]")?.textContent, "coreUnavailable");

      store.coreSnapshotAvailable = true;
      await nextTick();
      assert.equal(host.querySelector("[data-notice]")?.textContent, "coreDegraded");

      store.coreSnapshotError = null;
      await nextTick();
      assert.equal(host.querySelector("[data-notice]")?.textContent, "none");

      for (const [desired, healthy, active, label] of [
        [true, true, true, "settings.tunStateActive"],
        [true, true, false, "settings.tunStateInactive"],
        [true, true, undefined, "settings.tunStateUnverified"],
        [true, false, undefined, "settings.tunStateUnverified"],
        [false, true, true, "settings.tunStateUnexpected"],
        [false, true, false, null],
        [false, true, undefined, null],
      ] as const) {
        const status = healthyStatus();
        status.settings.tun = desired;
        status.core.healthy = healthy;
        if (active !== undefined) status.core.tunActive = active;
        store.status = status;
        await nextTick();
        assert.equal(host.querySelector("button")?.getAttribute("aria-pressed"), String(desired));
        assert.equal(host.querySelector("button")?.textContent, label ? t(label) : "off");
      }
    } finally {
      app.unmount();
      store.status = original.status;
      store.daemonOnline = original.daemonOnline;
      store.coreSnapshotAvailable = original.coreSnapshotAvailable;
      store.coreSnapshotError = original.coreSnapshotError;
      await window.close();
      for (const key of globalKeys) {
        const saved = previous.get(key);
        if (saved?.existed) Reflect.set(globalThis, key, saved.value);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});
