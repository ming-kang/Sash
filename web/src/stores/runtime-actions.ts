import { watch } from "vue";
import type { SettingsPatch } from "../../../src/contracts.js";
import { api } from "../api/index.js";
import { currentRoute } from "../router.js";
import { refreshVisibleCoreResources } from "./core-actions.js";
import {
  adoptDaemonStatus,
  requests,
  setProfiles,
  store,
  transitionRuntimeOwner,
} from "./state.js";
import { canSetSystemProxyTarget, isCoreHealthy } from "./state-ownership.js";

export function markDaemonOffline(): void {
  requests.invalidate("runtime");
  requests.invalidate("profiles");
  transitionRuntimeOwner(null);
  store.daemonOnline = false;
  store.status = null;
  api.markDisconnected();
}

type RuntimeRefreshResult = "status" | "stopped" | "degraded" | "superseded" | "unauthorized";

/** Metadata changes refresh metadata only. Core resources follow their own runtime epoch. */
export async function refreshStatus(
  request = requests.begin("runtime"),
): Promise<RuntimeRefreshResult> {
  const status = await api.getStatus();
  if (!requests.isCurrent("runtime", request)) return "superseded";
  adoptDaemonStatus(status);
  if (!api.sessionMatches(status.daemon.bootId)) {
    transitionRuntimeOwner(null);
    return "unauthorized";
  }
  transitionRuntimeOwner(status);
  if (store.lastProfileRevision !== status.revisions.profiles) {
    const profileRequest = requests.begin("profiles");
    try {
      const profiles = await api.getProfiles();
      if (
        requests.isCurrent("runtime", request) &&
        requests.isCurrent("profiles", profileRequest) &&
        store.status?.daemon.bootId === status.daemon.bootId
      ) {
        setProfiles(profiles);
        store.lastProfileRevision = status.revisions.profiles;
      }
    } catch {
      /* Keep the prior list and retry its revision on the next poll. */
    }
  }
  if (!requests.isCurrent("runtime", request)) return "superseded";
  return isCoreHealthy(status) ? "status" : status.core.running ? "degraded" : "stopped";
}

export async function refreshRuntimeState(): Promise<void> {
  if ((await refreshStatus()) === "status") await refreshVisibleCoreResources(0, true);
}

/** One non-overlapping poll; session initialization is needed only on entry or reconnect. */
export function startRuntimePolling(intervalMs = 2000): () => void {
  const backgroundInterval = Math.max(intervalMs, 15_000);
  let stopped = false;
  let running = false;
  let refreshWhenIdle = false;
  let timer: number | null = null;
  let cycle = 0;
  let activeRequest = 0;
  const clearTimer = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const schedule = (delay: number): void => {
    clearTimer();
    timer = window.setTimeout(() => {
      timer = null;
      void tick();
    }, delay);
  };
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    const request = requests.begin("runtime");
    activeRequest = request;
    const current = () => !stopped && requests.isCurrent("runtime", request);
    try {
      if (!api.isInitialized()) await api.initialize(current);
      if (!current()) return;
      const result = await refreshStatus(request);
      if (!current()) return;
      cycle += 1;
      if (result === "status" && !document.hidden) await refreshVisibleCoreResources(cycle);
    } catch {
      if (current()) markDaemonOffline();
    } finally {
      running = false;
      if (!stopped) {
        if (refreshWhenIdle && !document.hidden) {
          refreshWhenIdle = false;
          schedule(0);
        } else schedule(document.hidden || !api.hasSession() ? backgroundInterval : intervalMs);
      }
    }
  };
  const onVisibility = (): void => {
    clearTimer();
    if (document.hidden) {
      refreshWhenIdle = false;
      if (!running) schedule(backgroundInterval);
    } else if (running) refreshWhenIdle = true;
    else void tick();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const onHashChange = (): void => {
    if (api.isInitialized()) return;
    if (running) refreshWhenIdle = true;
    else void tick();
  };
  window.addEventListener("hashchange", onHashChange);
  const stopRouteWatch = watch(currentRoute, () => {
    if (!stopped && !document.hidden && api.hasSession() && isCoreHealthy(store.status))
      void refreshVisibleCoreResources(0, true);
  });
  void tick();
  return () => {
    stopped = true;
    if (running && requests.isCurrent("runtime", activeRequest)) requests.invalidate("runtime");
    clearTimer();
    stopRouteWatch();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("hashchange", onHashChange);
  };
}

export async function setSystemProxyEnabled(target: boolean): Promise<boolean> {
  if (store.operations.systemProxy) return false;
  if (!canSetSystemProxyTarget(store.status, target))
    throw new Error(target ? "Core is not healthy" : "System proxy is already off");
  store.operations = { ...store.operations, systemProxy: true };
  const bootId = store.status?.daemon.bootId;
  requests.invalidate("runtime");
  try {
    const result = await (target ? api.enableSystemProxy() : api.disableSystemProxy());
    if (store.status?.daemon.bootId === bootId && store.status)
      store.status = {
        ...store.status,
        settings: result.settings,
        systemProxy: { ...store.status.systemProxy, desired: result.settings.systemProxy },
      };
    return await refreshStatus().then(
      (value) => value !== "superseded" && value !== "unauthorized",
      () => false,
    );
  } catch (error) {
    await refreshStatus().catch(() => undefined);
    throw error;
  } finally {
    store.operations = { ...store.operations, systemProxy: false };
  }
}

export async function saveNetworkSettings(
  patch: Pick<SettingsPatch, "mixedPort" | "allowLan">,
): Promise<boolean> {
  if (store.operations.networkSetting) return false;
  store.operations = { ...store.operations, networkSetting: true };
  const bootId = store.status?.daemon.bootId;
  requests.invalidate("runtime");
  try {
    const result = await api.patchSettings(patch);
    if (store.status?.daemon.bootId === bootId && store.status)
      store.status = { ...store.status, settings: result.settings };
    return await refreshStatus().then(
      (status) => status !== "superseded" && status !== "unauthorized",
      () => false,
    );
  } catch (error) {
    await refreshStatus().catch(() => undefined);
    throw error;
  } finally {
    store.operations = { ...store.operations, networkSetting: false };
  }
}
