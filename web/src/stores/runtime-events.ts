import { watch } from "vue";
import { SashApiError } from "../../../src/sash-client.js";
import { api } from "../api/index.js";
import { currentRoute } from "../router.js";
import { refreshVisibleCoreResources } from "./core-actions.js";
import { refreshProfiles } from "./profile-actions.js";
import { adoptRuntimeSnapshot, markDaemonOffline } from "./runtime-actions.js";
import { isConnected, isCoreHealthy, resetCoreState, store } from "./state.js";

const RECONNECT_MS = 2000;

export function startRuntimeEvents(intervalMs = 2000): () => void {
  let stopped = false;
  let stream: AbortController | null = null;
  let retryTimer: number | null = null;
  let resourceTimer: number | null = null;
  let runningResources = false;
  let pendingForce = false;
  let cycle = 0;

  const isHidden = (): boolean => typeof document !== "undefined" && Boolean(document.hidden);

  const stopResourceTimer = (): void => {
    if (resourceTimer !== null) {
      window.clearTimeout(resourceTimer);
      resourceTimer = null;
    }
  };

  const scheduleResourceTick = (): void => {
    if (stopped || isHidden()) return;
    stopResourceTimer();
    resourceTimer = window.setTimeout(() => {
      resourceTimer = null;
      void resourceTick();
    }, intervalMs);
  };

  const refreshResources = async (force = false): Promise<void> => {
    if (stopped || !isConnected.value) return;
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
  const resourceTick = async (force = false): Promise<void> => {
    if (stopped || isHidden()) return;
    try {
      await refreshResources(force);
    } finally {
      if (!stopped && !isHidden()) scheduleResourceTick();
    }
  };

  const onVisibilityChange = (): void => {
    if (stopped) return;
    if (isHidden()) {
      stopResourceTimer();
    } else {
      stopResourceTimer();
      void resourceTick(true);
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void connect();
    }, RECONNECT_MS);
  };

  const connect = async (): Promise<void> => {
    if (stopped || stream) return;
    const controller = new AbortController();
    stream = controller;
    const active = () => stream === controller && !controller.signal.aborted;
    try {
      for await (const event of api.events(controller.signal)) {
        if (!active()) return;
        await adoptRuntimeSnapshot(event.status);
        if (!active()) return;
        store.tun = event.tun;
        store.connection = "connected";
        void refreshResources();
      }
      throw new Error("Daemon event stream closed");
    } catch (error) {
      if (!active()) return;
      if (error instanceof SashApiError && error.status === 401) {
        store.connection = "refused";
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

  const stopRouteWatch = watch(currentRoute, () => {
    void refreshResources(true);
  });
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  void connect();
  void resourceTick();
  return () => {
    stopped = true;
    stream?.abort();
    stream = null;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    stopResourceTimer();
    stopRouteWatch();
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}
