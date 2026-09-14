import type { DaemonStatus } from "../../../src/contracts.js";

export type { ProfileMeta, ProfilesResponse, RoutingMode } from "../../../src/contracts.js";
export type {
  ConfigsResponse,
  ConnectionItem,
  ConnectionsResponse,
  LogMessage,
  ProxiesResponse,
  ProxyItem,
  RuleItem,
  RulesResponse,
  TrafficMessage,
} from "../../../src/mihomo-api.js";

export type SashStatus = DaemonStatus;

/** Zero is a measured timeout; request failures have no measured latency. */
export type ProxyDelay = number | "failed";
