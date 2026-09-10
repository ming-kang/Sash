import { watch } from "vue";
import { SashApiError } from "../../../src/sash-client.js";
import { api } from "../api/index.js";
import { currentRoute } from "../router.js";
import { refreshVisibleCoreResources } from "./core-actions.js";
import { refreshProfiles } from "./profile-actions.js";
import { adoptRuntimeSnapshot, markDaemonOffline, refreshStatus } from "./runtime-actions.js";
import { isCoreHealthy, resetCoreState, store } from "./state.js";

const RECONNECT_MS = 2000;

/** Status is pushed; Core telemetry snapshots follow one visible-page poll. */
export function startRuntimeEvents(intervalMs = 2000): () => void {
  let stopped = false;
  let stream: AbortController | null = null;
  let retryTimer: number | null = null;
  let resourceTimer: number | null = null;
  let runningResources = false;
  let pendingForce = false;
  let cycle = 0;

  const refreshResources = async (force = false): Promise<void> => {
    if (stopped || !api.hasSession()) return;
    if (runningResources) {
      pendingForce ||= force;
      return;
    }
    runningResources = true;
    const forced = force || pendingForce;
    pendingForce = false;
    try {
      if (store.status && store.lastStateRevision !== store.status.revisions.state)
        await refreshProfiles().catch(() => undefined);
      if (!stopped && isCoreHealthy(store.status))
        await refreshVisibleCoreResources(++cycle, forced);
    } finally {
      runningResources = false;
      if (pendingForce && !stopped) void refreshResources();
    }
  };
  const resourceTick = async (): Promise<void> => {
    await refreshResources();
    if (!stopped)
      resourceTimer = window.setTimeout(() => {
        void resourceTick();
      }, intervalMs);
  };

  const scheduleReconnect = (delay = RECONNECT_MS): void => {
    if (stopped || retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  const connect = async (): Promise<void> => {
    if (stopped || stream) return;
    const controller = new AbortController();
    stream = controller;
    const active = () => stream === controller && !controller.signal.aborted;
    try {
      await api.initialize(active);
      if (!active()) return;
      if (!api.hasSession()) {
        await refreshStatus();
        return;
      }
      for await (const event of api.events(controller.signal)) {
        if (!active()) return;
        const result = await adoptRuntimeSnapshot(event.status);
        if (!active() || result === "unauthorized") return;
        void refreshResources();
      }
      throw new Error("Daemon event stream closed");
    } catch (error) {
      if (!active()) return;
      if (error instanceof SashApiError && error.status === 401) {
        store.daemonOnline = true;
        resetCoreState();
      } else markDaemonOffline();
    } finally {
      controller.abort();
      if (stream === controller) {
        stream = null;
        scheduleReconnect();
      }
    }
  };

  const onHashChange = (): void => {
    if (api.isInitialized()) return;
    stream?.abort();
    stream = null;
    scheduleReconnect(0);
  };

  const stopRouteWatch = watch(currentRoute, () => {
    void refreshResources(true);
  });
  window.addEventListener("hashchange", onHashChange);
  void connect();
  void resourceTick();
  return () => {
    stopped = true;
    stream?.abort();
    stream = null;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    if (resourceTimer !== null) window.clearTimeout(resourceTimer);
    stopRouteWatch();
    window.removeEventListener("hashchange", onHashChange);
  };
}
