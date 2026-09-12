import type { DaemonStatus, RoutingMode } from "../../../src/contracts.js";

export type { ProfileMeta, ProfilesResponse, RoutingMode } from "../../../src/contracts.js";

export type SashStatus = DaemonStatus;

/** Zero is a measured timeout; request failures have no measured latency. */
export type ProxyDelay = number | "failed";

export interface ProxyItem {
  name: string;
  type: string;
  udp: boolean;
  history: Array<{ time: string; delay: number }>;
  now?: string;
  all?: string[];
  alive?: boolean;
}

export interface ProxiesResponse {
  proxies: Record<string, ProxyItem>;
}

export interface ConnectionItem {
  id: string;
  metadata: {
    network: string;
    type: string;
    sourceIP: string;
    destinationIP: string;
    sourcePort: string;
    destinationPort: string;
    host: string;
    dnsMode?: string;
    processPath?: string;
  };
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
}

export interface ConnectionsResponse {
  downloadTotal: number;
  uploadTotal: number;
  connections: ConnectionItem[] | null;
}

export interface TrafficMessage {
  up: number;
  down: number;
}

export interface LogMessage {
  type: "info" | "warning" | "error" | "debug";
  payload: string;
  time?: string;
}

export interface RuleItem {
  type: string;
  payload: string;
  proxy: string;
}

export interface RulesResponse {
  rules: RuleItem[];
}

export interface ConfigsResponse {
  port: number;
  "socks-port": number;
  "redir-port": number;
  "tproxy-port": number;
  "mixed-port": number;
  "allow-lan": boolean;
  mode: RoutingMode;
  "log-level": string;
}
