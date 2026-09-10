import type { SettingsPatch } from "../../../src/contracts.js";
import { api } from "../api/index.js";
import { t } from "../i18n/index.js";
import type { SashStatus } from "../types/index.js";
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
  return adoptRuntimeSnapshot(status, request);
}

export async function adoptRuntimeSnapshot(
  status: SashStatus,
  request = requests.begin("runtime"),
): Promise<RuntimeRefreshResult> {
  if (!requests.isCurrent("runtime", request)) return "superseded";
  if (
    store.status?.daemon.bootId === status.daemon.bootId &&
    (status.revisions.state < store.status.revisions.state ||
      status.revisions.runtime < store.status.revisions.runtime)
  )
    return "superseded";
  adoptDaemonStatus(status);
  if (!api.sessionMatches(status.daemon.bootId)) {
    transitionRuntimeOwner(null);
    return "unauthorized";
  }
  transitionRuntimeOwner(status);
  if (store.lastStateRevision !== status.revisions.state) {
    const profileRequest = requests.begin("profiles");
    try {
      const profiles = await api.getProfiles();
      if (
        requests.isCurrent("runtime", request) &&
        requests.isCurrent("profiles", profileRequest) &&
        store.status?.daemon.bootId === status.daemon.bootId
      ) {
        setProfiles(profiles);
        store.lastStateRevision = status.revisions.state;
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

export async function setSystemProxyEnabled(target: boolean): Promise<boolean> {
  if (store.operations.systemProxy) return false;
  if (!canSetSystemProxyTarget(store.status, target))
    throw new Error(target ? t("errors.coreUnavailable") : t("errors.proxyAlreadyOff"));
  store.operations = { ...store.operations, systemProxy: true };
  const bootId = store.status?.daemon.bootId;
  requests.invalidate("runtime");
  try {
    const revision = store.status?.revisions.state;
    const result = await (target
      ? api.enableSystemProxy(revision)
      : api.disableSystemProxy(revision));
    if (
      store.status?.daemon.bootId === bootId &&
      store.status &&
      result.revision >= store.status.revisions.state
    )
      store.status = {
        ...store.status,
        revisions: { ...store.status.revisions, state: result.revision },
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
    const result = await api.patchSettings({
      ...patch,
      expectedRevision: store.status?.revisions.state,
    });
    if (
      store.status?.daemon.bootId === bootId &&
      store.status &&
      result.revision >= store.status.revisions.state
    )
      store.status = {
        ...store.status,
        settings: result.settings,
        revisions: { ...store.status.revisions, state: result.revision },
      };
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
