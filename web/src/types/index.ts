export type OutboundMode = "rule" | "global" | "direct";

export interface SashStatus {
  daemon: {
    pid: number;
    startedAt: string;
    port: number;
  };
  core: {
    running: boolean;
    pid?: number;
    startedAt?: string;
    healthy?: boolean;
    version?: string;
  };
  systemProxy: {
    desired: boolean;
    applied: boolean;
    actual?: {
      supported: boolean;
      enabled: boolean;
      server?: string;
      details?: string;
    };
  };
  settings: {
    subscriptionUrl: string;
    mixedPort: number;
    controller: string;
    secret: string;
    tun: boolean;
    coreVersion: string;
    uiVersion: string;
    allowLan: boolean;
    daemonPort: number;
    daemonSecret: string;
    systemProxy: boolean;
  };
  activeProfile?: { id: string; name: string; url: string } | null;
}

export interface ProfileSubInfo {
  upload: number;
  download: number;
  total: number;
  /** Unix epoch seconds. */
  expire?: number;
}

export interface ProfileMeta {
  id: string;
  name: string;
  /** Remote subscription URL; "" for imported/local files. */
  url: string;
  intervalHours: number;
  createdAt: string;
  updatedAt: string;
  subInfo?: ProfileSubInfo;
  homePage?: string;
  lastError?: string;
}

export interface ProfilesResponse {
  activeId: string | null;
  profiles: ProfileMeta[];
}

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
  connections: ConnectionItem[];
}

export interface TrafficMessage {
  up: number;
  down: number;
}

export interface MemoryMessage {
  inuse: number;
  osalloc: number;
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
  mode: OutboundMode;
  "log-level": string;
}
