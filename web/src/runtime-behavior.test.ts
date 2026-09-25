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

  it("pauses periodic Core resource polling while document is hidden and refreshes on visible", async (t) => {
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

    t.mock.timers.enable({ apis: ["setTimeout"] });
    window.setTimeout = globalThis.setTimeout;
    window.clearTimeout = globalThis.clearTimeout;

    const { api } = await import("./api/index.js");
    const { startRuntimeEvents, store } = await import("./stores/index.js");

    const originalApi = {
      hasSession: api.hasSession,
      isInitialized: api.isInitialized,
      initialize: api.initialize,
      events: api.events,
      getConfigs: api.getConfigs,
      getProxies: api.getProxies,
      getRules: api.getRules,
      getConnections: api.getConnections,
      getProfiles: api.getProfiles,
    };
    const originalStore = {
      status: store.status,
      daemonOnline: store.daemonOnline,
      resourceLoaded: store.resourceLoaded,
      resourceErrors: store.resourceErrors,
    };

    const flush = async (rounds = 4): Promise<void> => {
      for (let i = 0; i < rounds; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };

    let configReads = 0;
    api.hasSession = () => true;
    api.isInitialized = () => true;
    api.initialize = async () => ({
      token: "health",
      pid: 100,
      startedAt: "2026-01-01T00:00:00.000Z",
      version: "1.0.0",
    });
    api.events = (signal) =>
      (async function* () {
        while (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      })();
    api.getConfigs = async () => {
      configReads += 1;
      return { mode: "rule" } as Awaited<ReturnType<typeof api.getConfigs>>;
    };
    api.getProxies = async () => ({ proxies: {} });
    api.getRules = async () => ({ rules: [] });
    api.getConnections = async () => ({
      connections: null,
      uploadTotal: 0,
      downloadTotal: 0,
    });
    api.getProfiles = async () => ({ activeId: null, profiles: [] });

    store.status = healthyStatus();
    store.daemonOnline = true;
    store.resourceLoaded = {};
    store.resourceErrors = {};

    let stopRuntime: (() => void) | null = null;
    try {
      stopRuntime = startRuntimeEvents(2000);
      await flush();
      assert.equal(configReads, 1, "initial read on visible startup");

      t.mock.timers.tick(2000);
      await flush();
      t.mock.timers.tick(2000);
      await flush();
      assert.equal(configReads, 2, "periodic polling occurs while visible");

      Object.defineProperty(window.document, "hidden", { value: true, configurable: true });
      window.document.dispatchEvent(new window.Event("visibilitychange"));
      await flush();

      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(configReads, 2, "no polls occur while document is hidden");

      Object.defineProperty(window.document, "hidden", { value: false, configurable: true });
      window.document.dispatchEvent(new window.Event("visibilitychange"));
      await flush();
      assert.equal(configReads, 3, "immediately refreshes resources when document becomes visible");

      t.mock.timers.tick(2000);
      await flush();
      t.mock.timers.tick(2000);
      await flush();
      assert.equal(configReads, 4, "periodic ticking resumes after becoming visible");

      Object.defineProperty(window.document, "hidden", { value: true, configurable: true });
      window.document.dispatchEvent(new window.Event("visibilitychange"));
      await flush();
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(configReads, 4, "polling pauses again when hidden a second time");

      stopRuntime();
      stopRuntime = null;

      Object.defineProperty(window.document, "hidden", { value: false, configurable: true });
      window.document.dispatchEvent(new window.Event("visibilitychange"));
      await flush();
      assert.equal(configReads, 4, "no refresh on visibilitychange after stop");
    } finally {
      stopRuntime?.();
      Object.assign(api, originalApi);
      store.status = originalStore.status;
      store.daemonOnline = originalStore.daemonOnline;
      store.resourceLoaded = originalStore.resourceLoaded;
      store.resourceErrors = originalStore.resourceErrors;
      await window.close();
      for (const key of globalKeys) {
        const saved = previous.get(key);
        if (saved?.existed) Reflect.set(globalThis, key, saved.value);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  it("does not poll on startup when document is already hidden until visible", async (t) => {
    const window = new HappyWindow({ url: "http://127.0.0.1:19090/ui/" });
    Object.defineProperty(window.document, "hidden", { value: true, configurable: true });

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

    t.mock.timers.enable({ apis: ["setTimeout"] });
    window.setTimeout = globalThis.setTimeout;
    window.clearTimeout = globalThis.clearTimeout;

    const { api } = await import("./api/index.js");
    const { startRuntimeEvents, store } = await import("./stores/index.js");

    const originalApi = {
      hasSession: api.hasSession,
      isInitialized: api.isInitialized,
      initialize: api.initialize,
      events: api.events,
      getConfigs: api.getConfigs,
      getProxies: api.getProxies,
      getRules: api.getRules,
      getConnections: api.getConnections,
      getProfiles: api.getProfiles,
    };
    const originalStore = {
      status: store.status,
      daemonOnline: store.daemonOnline,
      resourceLoaded: store.resourceLoaded,
      resourceErrors: store.resourceErrors,
    };

    const flush = async (rounds = 4): Promise<void> => {
      for (let i = 0; i < rounds; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };

    let configReads = 0;
    api.hasSession = () => true;
    api.isInitialized = () => true;
    api.initialize = async () => ({
      token: "health",
      pid: 100,
      startedAt: "2026-01-01T00:00:00.000Z",
      version: "1.0.0",
    });
    api.events = (signal) =>
      (async function* () {
        while (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      })();
    api.getConfigs = async () => {
      configReads += 1;
      return { mode: "rule" } as Awaited<ReturnType<typeof api.getConfigs>>;
    };
    api.getProxies = async () => ({ proxies: {} });
    api.getRules = async () => ({ rules: [] });
    api.getConnections = async () => ({
      connections: null,
      uploadTotal: 0,
      downloadTotal: 0,
    });
    api.getProfiles = async () => ({ activeId: null, profiles: [] });

    store.status = healthyStatus();
    store.daemonOnline = true;
    store.resourceLoaded = {};
    store.resourceErrors = {};

    let stopRuntime: (() => void) | null = null;
    try {
      stopRuntime = startRuntimeEvents(2000);
      await flush();
      assert.equal(configReads, 0, "no initial read when document is hidden at start");

      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(configReads, 0, "no polls while staying hidden");

      Object.defineProperty(window.document, "hidden", { value: false, configurable: true });
      window.document.dispatchEvent(new window.Event("visibilitychange"));
      await flush();
      assert.equal(configReads, 1, "immediate forced refresh upon becoming visible");

      t.mock.timers.tick(2000);
      await flush();
      t.mock.timers.tick(2000);
      await flush();
      assert.equal(configReads, 2, "periodic ticking resumes after initial visibility");
    } finally {
      stopRuntime?.();
      Object.assign(api, originalApi);
      store.status = originalStore.status;
      store.daemonOnline = originalStore.daemonOnline;
      store.resourceLoaded = originalStore.resourceLoaded;
      store.resourceErrors = originalStore.resourceErrors;
      await window.close();
      for (const key of globalKeys) {
        const saved = previous.get(key);
        if (saved?.existed) Reflect.set(globalThis, key, saved.value);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  it("allows in-flight poll to complete on hide without scheduling further ticks", async (t) => {
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

    t.mock.timers.enable({ apis: ["setTimeout"] });
    window.setTimeout = globalThis.setTimeout;
    window.clearTimeout = globalThis.clearTimeout;

    const { api } = await import("./api/index.js");
    const { startRuntimeEvents, store } = await import("./stores/index.js");

    const originalApi = {
      hasSession: api.hasSession,
      isInitialized: api.isInitialized,
      initialize: api.initialize,
      events: api.events,
      getConfigs: api.getConfigs,
      getProxies: api.getProxies,
      getRules: api.getRules,
      getConnections: api.getConnections,
      getProfiles: api.getProfiles,
    };
    const originalStore = {
      status: store.status,
      daemonOnline: store.daemonOnline,
      resourceLoaded: store.resourceLoaded,
      resourceErrors: store.resourceErrors,
    };

    const flush = async (rounds = 4): Promise<void> => {
      for (let i = 0; i < rounds; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };

    let finishInFlight: (() => void) | null = null;
    let configReads = 0;
    api.hasSession = () => true;
    api.isInitialized = () => true;
    api.initialize = async () => ({
      token: "health",
      pid: 100,
      startedAt: "2026-01-01T00:00:00.000Z",
      version: "1.0.0",
    });
    api.events = (signal) =>
      (async function* () {
        while (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      })();
    api.getConfigs = async () => {
      configReads += 1;
      if (finishInFlight) {
        await new Promise<void>((resolve) => {
          finishInFlight = resolve;
        });
      }
      return { mode: "rule" } as Awaited<ReturnType<typeof api.getConfigs>>;
    };
    api.getProxies = async () => ({ proxies: {} });
    api.getRules = async () => ({ rules: [] });
    api.getConnections = async () => ({
      connections: null,
      uploadTotal: 0,
      downloadTotal: 0,
    });
    api.getProfiles = async () => ({ activeId: null, profiles: [] });

    store.status = healthyStatus();
    store.daemonOnline = true;
    store.resourceLoaded = {};
    store.resourceErrors = {};

    let stopRuntime: (() => void) | null = null;
    try {
      let resolveFirst: () => void = () => {};
      finishInFlight = () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });

      stopRuntime = startRuntimeEvents(2000);
      await flush();
      assert.equal(configReads, 1, "in-flight request started");

      Object.defineProperty(window.document, "hidden", { value: true, configurable: true });
      window.document.dispatchEvent(new window.Event("visibilitychange"));
      await flush();

      finishInFlight = null;
      resolveFirst();
      await flush();

      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(configReads, 1, "no further polls scheduled after in-flight tick completed");
    } finally {
      stopRuntime?.();
      Object.assign(api, originalApi);
      store.status = originalStore.status;
      store.daemonOnline = originalStore.daemonOnline;
      store.resourceLoaded = originalStore.resourceLoaded;
      store.resourceErrors = originalStore.resourceErrors;
      await window.close();
      for (const key of globalKeys) {
        const saved = previous.get(key);
        if (saved?.existed) Reflect.set(globalThis, key, saved.value);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});
