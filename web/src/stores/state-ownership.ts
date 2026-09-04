import type { PublicSashSettings } from "../../../src/settings.js";
import type { LogMessage, ProxyItem, SashStatus, TrafficMessage } from "../types/index.js";

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
  state.traffic = {
    up: 0,
    down: 0,
    historyUp: Array(historyLength).fill(0),
    historyDown: Array(historyLength).fill(0),
  };
  state.manualProxyDelays = {};
  state.activeGroup = "";
  state.runtimeGeneration += 1;
}

export function isCoreHealthy(status: SashStatus | null): boolean {
  return Boolean(status?.core.running && status.core.healthy);
}

export function runtimeOwnerKey(status: SashStatus | null): string | null {
  if (!isCoreHealthy(status)) return null;
  return [
    status?.daemon.startedAt ?? "",
    status?.core.pid ?? "",
    status?.core.startedAt ?? "",
  ].join("|");
}

export function runtimeCoherenceKey(status: SashStatus | null): string | null {
  const owner = runtimeOwnerKey(status);
  return owner === null ? null : `${owner}|${status?.revisions.profiles ?? 0}`;
}

export function needsRecoveryRefresh(previous: SashStatus | null, next: SashStatus): boolean {
  const nextKey = runtimeCoherenceKey(next);
  if (nextKey === null) return false;
  return runtimeCoherenceKey(previous) !== nextKey;
}

export type RuntimeNoticeKind = "offline" | "coreDegraded" | "coreUnavailable";

export function runtimeNoticeKind(
  daemonOnline: boolean,
  coreHealthy: boolean,
  snapshotAvailable: boolean,
  snapshotError: string | null,
): RuntimeNoticeKind | null {
  if (!daemonOnline) return "offline";
  if (!coreHealthy || snapshotError === null) return null;
  return snapshotAvailable ? "coreDegraded" : "coreUnavailable";
}

export function isCommittedDraftDirty<T>(draft: T, committed: T): boolean {
  return !Object.is(draft, committed);
}

export function reconcileCommittedDraft<T>(
  draft: T,
  previousCommitted: T,
  nextCommitted: T,
  saving: boolean,
): T {
  return !saving && Object.is(draft, previousCommitted) ? nextCommitted : draft;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseTrafficFrame(value: unknown): TrafficMessage | null {
  const frame = objectRecord(value);
  if (!frame) return null;
  const { up, down } = frame;
  if (
    typeof up !== "number" ||
    !Number.isFinite(up) ||
    up < 0 ||
    typeof down !== "number" ||
    !Number.isFinite(down) ||
    down < 0
  ) {
    return null;
  }
  return { up, down };
}

const LOG_TYPES = new Set<LogMessage["type"]>(["info", "warning", "error", "debug"]);

export function parseLogFrame(value: unknown): LogMessage | null {
  const frame = objectRecord(value);
  if (!frame || typeof frame.type !== "string" || typeof frame.payload !== "string") return null;
  if (!LOG_TYPES.has(frame.type as LogMessage["type"])) return null;
  return { type: frame.type as LogMessage["type"], payload: frame.payload };
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
