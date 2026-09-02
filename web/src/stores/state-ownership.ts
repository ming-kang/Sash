import type { PublicSashSettings } from "../../../src/settings.js";
import type { ProxyItem, SashStatus } from "../types/index.js";

export class RequestGenerations {
  private readonly values = new Map<string, number>();

  begin(domain: string): number {
    const next = (this.values.get(domain) ?? 0) + 1;
    this.values.set(domain, next);
    return next;
  }

  invalidate(domain: string): void {
    this.begin(domain);
  }

  isCurrent(domain: string, generation: number): boolean {
    return this.values.get(domain) === generation;
  }
}

export interface CoreOwnedState {
  mode: "rule" | "global" | "direct";
  proxies: Record<string, ProxyItem>;
  proxyGroups: string[];
  connections: unknown[];
  connectionsUploadTotal: number;
  connectionsDownloadTotal: number;
  rules: unknown[];
  traffic: {
    up: number;
    down: number;
    historyUp: number[];
    historyDown: number[];
  };
  manualProxyDelays: Record<string, number>;
  activeGroup: string;
  runtimeGeneration: number;
}

export function clearCoreOwnedState(state: CoreOwnedState, historyLength: number): void {
  state.mode = "rule";
  state.proxies = {};
  state.proxyGroups = [];
  state.connections = [];
  state.connectionsUploadTotal = 0;
  state.connectionsDownloadTotal = 0;
  state.rules = [];
  state.traffic.up = 0;
  state.traffic.down = 0;
  state.traffic.historyUp = Array(historyLength).fill(0);
  state.traffic.historyDown = Array(historyLength).fill(0);
  state.manualProxyDelays = {};
  state.activeGroup = "";
  state.runtimeGeneration += 1;
}

export function isCoreHealthy(status: SashStatus | null): boolean {
  return Boolean(status?.core.running && status.core.healthy);
}

export function runtimeCoherenceKey(status: SashStatus | null): string | null {
  if (!isCoreHealthy(status)) return null;
  return [
    status?.daemon.startedAt ?? "",
    status?.core.pid ?? "",
    status?.core.startedAt ?? "",
    status?.revisions.profiles ?? 0,
  ].join("|");
}

export function needsRecoveryRefresh(previous: SashStatus | null, next: SashStatus): boolean {
  const nextKey = runtimeCoherenceKey(next);
  if (nextKey === null) return false;
  return runtimeCoherenceKey(previous) !== nextKey;
}

export type TunRuntimeState =
  | "off"
  | "stopped"
  | "active"
  | "inactive"
  | "unverified"
  | "unexpected-active";

export function tunRuntimeState(status: SashStatus | null): TunRuntimeState {
  const desired = status?.settings.tun ?? false;
  if (!isCoreHealthy(status)) return desired ? "stopped" : "off";
  if (status?.core.tunActive === true) return desired ? "active" : "unexpected-active";
  if (!desired) return "off";
  return status?.core.tunActive === false ? "inactive" : "unverified";
}

export function systemProxyNeedsDisable(status: SashStatus | null): boolean {
  return Boolean(
    status?.systemProxy.desired ||
      status?.systemProxy.applied ||
      status?.systemProxy.actual?.enabled,
  );
}

export function canSetSystemProxyTarget(status: SashStatus | null, target: boolean): boolean {
  return target ? isCoreHealthy(status) : systemProxyNeedsDisable(status);
}

export function resolvedProxyDelay(
  name: string,
  proxies: Record<string, ProxyItem>,
  manualDelays: Record<string, number>,
): number | undefined {
  const manual = manualDelays[name];
  if (manual !== undefined) return manual;
  return proxies[name]?.history?.at(-1)?.delay;
}

export function syncCommittedBooleanSetting(
  status: SashStatus | null,
  key: "allow-lan" | "tun",
  value: boolean,
  committed?: PublicSashSettings,
): SashStatus | null {
  if (!status) return null;
  return {
    ...status,
    settings: committed ?? {
      ...status.settings,
      [key === "allow-lan" ? "allowLan" : "tun"]: value,
    },
  };
}

export async function runProfileMutationSequence<T>(
  mutation: () => Promise<T>,
  refreshProfiles: () => Promise<void>,
  refreshRuntime?: (result: T) => Promise<void>,
): Promise<T> {
  let result: T | undefined;
  let mutationError: unknown;
  try {
    result = await mutation();
  } catch (err) {
    mutationError = err;
  }

  try {
    await refreshProfiles();
  } catch (refreshError) {
    if (mutationError === undefined) throw refreshError;
  }

  if (mutationError !== undefined) throw mutationError;
  const committed = result as T;
  await refreshRuntime?.(committed);
  return committed;
}
