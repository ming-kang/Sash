import { watch } from "vue";
import { SashApiError } from "../../../src/sash-client.js";
import { api } from "../api/index.js";
import { currentRoute } from "../router.js";
import { refreshVisibleCoreResources } from "./core-actions.js";
import { refreshProfiles } from "./profile-actions.js";
import { adoptRuntimeSnapshot, markDaemonOffline, refreshStatus } from "./runtime-actions.js";
import { requests, store, transitionRuntimeOwner } from "./state.js";
import { isCoreHealthy } from "./state-ownership.js";

/** Status is pushed; Core telemetry snapshots retain one non-overlapping visible-page poll. */
export function startRuntimeEvents(intervalMs = 2000): () => void {
  let stopped = false;
  let stream: AbortController | null = null;
  let retryTimer: number | null = null;
  let resourceTimer: number | null = null;
  let runningResources = false;
  let forceResources = false;
  let cycle = 0;
  let failures = 0;

  const refreshResources = async (force = false): Promise<void> => {
    if (stopped || document.hidden || !api.hasSession()) return;
    forceResources ||= force;
    if (runningResources) return;
    runningResources = true;
    const forced = forceResources;
    forceResources = false;
    try {
      if (store.status && store.lastStateRevision !== store.status.revisions.state)
        await refreshProfiles().catch(() => undefined);
      if (!stopped && isCoreHealthy(store.status))
        await refreshVisibleCoreResources(++cycle, forced);
    } finally {
      runningResources = false;
      if (forceResources && !stopped) void refreshResources();
    }
  };
  const resourceTick = async (): Promise<void> => {
    await refreshResources();
    if (!stopped)
      resourceTimer = window.setTimeout(
        () => {
          void resourceTick();
        },
        document.hidden ? 15_000 : intervalMs,
      );
  };
  const schedule = (delay: number): void => {
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    if (!stopped)
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void connect();
      }, delay);
  };
  const connect = async (): Promise<void> => {
    if (stopped || stream) return;
    const controller = new AbortController();
    stream = controller;
    let observation = requests.begin("runtime");
    const active = () => !stopped && stream === controller && !controller.signal.aborted;
    try {
      await api.initialize(() => active() && requests.isCurrent("runtime", observation));
      if (!active() || !requests.isCurrent("runtime", observation)) return;
      if (!api.hasSession()) {
        await refreshStatus(observation);
        return;
      }
      const session = api.getSessionGeneration();
      for await (const event of api.events(controller.signal)) {
        if (!active() || api.getSessionGeneration() !== session) return;
        failures = 0;
        const previousGeneration = store.runtimeGeneration;
        observation = requests.begin("runtime");
        const result = await adoptRuntimeSnapshot(event.status, observation);
        if (!active()) return;
        if (result === "unauthorized") return;
        void refreshResources(store.runtimeGeneration !== previousGeneration);
      }
      if (active()) throw new Error("Daemon event stream closed");
    } catch (error) {
      if (active() && requests.isCurrent("runtime", observation)) {
        if (error instanceof SashApiError && error.status === 401) {
          store.daemonOnline = true;
          transitionRuntimeOwner(null);
        } else markDaemonOffline();
      }
      if (active()) failures += 1;
    } finally {
      controller.abort();
      if (stream === controller) {
        stream = null;
        schedule(
          store.daemonOnline && !api.hasSession()
            ? 15_000
            : Math.min(10_000, 1000 * 2 ** Math.min(failures, 4)),
        );
      }
    }
  };

  const onVisibility = (): void => {
    if (!document.hidden) {
      void refreshResources(true);
      if (!stream) schedule(0);
    }
  };
  const onHashChange = (): void => {
    if (api.isInitialized()) return;
    stream?.abort();
    stream = null;
    schedule(0);
  };
  const stopRouteWatch = watch(currentRoute, () => {
    void refreshResources(true);
  });
  document.addEventListener("visibilitychange", onVisibility);
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
    requests.invalidate("runtime");
    requests.invalidate("profiles");
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("hashchange", onHashChange);
  };
}
