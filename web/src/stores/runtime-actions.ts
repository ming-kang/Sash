import type { SettingsPatch } from "../../../src/contracts.js";
import { api } from "../api/index.js";
import { t } from "../i18n/index.js";
import type { SashStatus } from "../types/index.js";
import { refreshVisibleCoreResources } from "./core-actions.js";
import {
  adoptDaemonStatus,
  canSetSystemProxyTarget,
  isCoreHealthy,
  resetCoreState,
  setProfiles,
  store,
} from "./state.js";

export function markDaemonOffline(): void {
  resetCoreState();
  store.daemonOnline = false;
  store.status = null;
  api.markDisconnected();
}

type RuntimeRefreshResult = "status" | "stopped" | "degraded" | "unauthorized";

/** Metadata changes refresh metadata only. Core resources follow their own runtime epoch. */
export async function refreshStatus(): Promise<RuntimeRefreshResult> {
  return adoptRuntimeSnapshot(await api.getStatus());
}

export async function adoptRuntimeSnapshot(status: SashStatus): Promise<RuntimeRefreshResult> {
  adoptDaemonStatus(status);
  if (!api.sessionMatches(status.daemon.bootId)) {
    resetCoreState();
    return "unauthorized";
  }
  if (store.lastStateRevision !== status.revisions.state) {
    try {
      setProfiles(await api.getProfiles());
      store.lastStateRevision = status.revisions.state;
    } catch {
      /* Keep the prior list and retry its revision on the next poll. */
    }
  }
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
  try {
    const revision = store.status?.revisions.state;
    await (target ? api.enableSystemProxy(revision) : api.disableSystemProxy(revision));
    return await refreshStatus().then(
      (result) => result !== "unauthorized",
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
  try {
    await api.patchSettings({
      ...patch,
      expectedRevision: store.status?.revisions.state,
    });
    return await refreshStatus().then(
      (result) => result !== "unauthorized",
      () => false,
    );
  } catch (error) {
    await refreshStatus().catch(() => undefined);
    throw error;
  } finally {
    store.operations = { ...store.operations, networkSetting: false };
  }
}
