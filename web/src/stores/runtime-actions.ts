import { watch } from "vue";
import { api } from "../api/index.js";
import { currentRoute } from "../router.js";
import type { SashStatus } from "../types/index.js";
import { refreshConnections, refreshCoreSnapshot, refreshProxies } from "./core-actions.js";
import {
  adoptDaemonStatus,
  requests,
  runtimeOwnership,
  setProfiles,
  store,
  transitionRuntimeOwner,
} from "./state.js";
import {
  canSetSystemProxyTarget,
  isCoreHealthy,
  syncCommittedBooleanSetting,
} from "./state-ownership.js";

export function markDaemonOffline(): void {
  requests.invalidate("runtime");
  requests.invalidate("profiles");
  transitionRuntimeOwner(null);
  store.daemonOnline = false;
  store.status = null;
}

async function refreshProfilesForStatus(
  status: SashStatus,
  runtimeRequest: number,
): Promise<boolean> {
  if (store.lastProfileRevision === status.revisions.profiles) return true;
  const profileRequest = requests.begin("profiles");
  try {
    const profiles = await api.getProfiles();
    if (
      !requests.isCurrent("runtime", runtimeRequest) ||
      !requests.isCurrent("profiles", profileRequest) ||
      store.status?.daemon.startedAt !== status.daemon.startedAt
    ) {
      return false;
    }
    setProfiles(profiles);
    store.lastProfileRevision = status.revisions.profiles;
    return true;
  } catch {
    return false;
  }
}

type RuntimeRefreshResult = "full" | "status" | "stopped" | "degraded";

async function refreshRuntime(forceSnapshot: boolean): Promise<RuntimeRefreshResult> {
  const runtimeRequest = requests.begin("runtime");
  const status = await api.getStatus();
  if (!requests.isCurrent("runtime", runtimeRequest)) return "status";
  adoptDaemonStatus(status);

  const profiles = refreshProfilesForStatus(status, runtimeRequest);
  if (!isCoreHealthy(status)) {
    await profiles;
    return "stopped";
  }

  const needsSnapshot =
    forceSnapshot ||
    !store.coreSnapshotAvailable ||
    store.coreSnapshotError !== null ||
    runtimeOwnership.snapshotProfileRevision !== status.revisions.profiles;
  if (!needsSnapshot) {
    await profiles;
    return "status";
  }

  const [, refreshed] = await Promise.all([profiles, refreshCoreSnapshot(status, runtimeRequest)]);
  return refreshed ? "full" : "degraded";
}

export async function refreshRuntimeState(): Promise<void> {
  await refreshRuntime(true);
}

export function refreshStatus(): Promise<RuntimeRefreshResult> {
  return refreshRuntime(false);
}

/** Self-scheduling polling prevents overlapping cycles and only probes Core after a healthy status. */
export function startRuntimePolling(intervalMs = 2000): () => void {
  const backgroundIntervalMs = Math.max(intervalMs, 15_000);
  let stopped = false;
  let running = false;
  let refreshWhenIdle = false;
  let timer: number | null = null;
  let cycle = 0;

  const clearTimer = (): void => {
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
  };

  const schedule = (delayMs: number): void => {
    clearTimer();
    timer = window.setTimeout(() => {
      timer = null;
      void tick();
    }, delayMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await api.initialize();
      const result = await refreshStatus();
      cycle += 1;
      if (result === "status" && isCoreHealthy(store.status)) {
        // Connection dumps are large; only views that show them need fresh data.
        if (currentRoute.value === "connections" || currentRoute.value === "overview") {
          await refreshConnections().catch(() => undefined);
        }
        if (cycle % 3 === 0) await refreshProxies().catch(() => undefined);
      }
    } catch {
      api.clearSession();
      markDaemonOffline();
    } finally {
      running = false;
      if (!stopped) {
        if (refreshWhenIdle && !document.hidden) {
          refreshWhenIdle = false;
          schedule(0);
        } else {
          schedule(document.hidden ? backgroundIntervalMs : intervalMs);
        }
      }
    }
  };

  const onVisibilityChange = (): void => {
    if (stopped) return;
    clearTimer();
    if (document.hidden) {
      refreshWhenIdle = false;
      if (!running) schedule(backgroundIntervalMs);
    } else if (running) {
      refreshWhenIdle = true;
    } else {
      void tick();
    }
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  // Navigating to a connection-aware view fetches immediately instead of
  // waiting out the polling interval on possibly stale rows.
  const stopRouteWatch = watch(currentRoute, (route) => {
    if (stopped) return;
    if ((route === "connections" || route === "overview") && isCoreHealthy(store.status)) {
      void refreshConnections().catch(() => undefined);
    }
  });
  void tick();
  return () => {
    stopped = true;
    refreshWhenIdle = false;
    clearTimer();
    stopRouteWatch();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

export async function setSystemProxyEnabled(target: boolean): Promise<void> {
  if (store.operations.systemProxy) return;
  if (!canSetSystemProxyTarget(store.status, target)) {
    throw new Error(
      target ? "Cannot enable system proxy: Core is not healthy" : "System proxy is already off",
    );
  }
  store.operations = { ...store.operations, systemProxy: true };
  requests.invalidate("runtime");
  try {
    if (target) await api.enableSystemProxy();
    else await api.disableSystemProxy();
    if (store.status) {
      store.status = {
        ...store.status,
        systemProxy: {
          ...store.status.systemProxy,
          desired: target,
          applied: target,
        },
      };
    }
    await refreshStatus();
  } finally {
    store.operations = { ...store.operations, systemProxy: false };
  }
}

export async function patchBooleanSetting(key: "allow-lan" | "tun", next: boolean): Promise<void> {
  if (store.operations.networkSetting) return;
  store.operations = { ...store.operations, networkSetting: true };
  requests.invalidate("runtime");
  try {
    const result = await api.patchSettings(key === "tun" ? { tun: next } : { allowLan: next });
    store.status = syncCommittedBooleanSetting(store.status, key, next, result.settings);
    await refreshRuntimeState();
  } finally {
    store.operations = { ...store.operations, networkSetting: false };
  }
}
