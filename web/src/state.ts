import type {
  ConfigsResponse,
  ConnectionItem,
  LogMessage,
  OutboundMode,
  ProxyItem,
  RuleItem,
  SashStatus,
  TrafficMessage,
} from "./types.js";

export interface AppState {
  authenticated: boolean;
  status: SashStatus | null;
  mode: OutboundMode;
  traffic: {
    up: number;
    down: number;
    historyUp: number[];
    historyDown: number[];
  };
  proxies: Record<string, ProxyItem>;
  proxyGroups: string[];
  connections: ConnectionItem[];
  connectionsUploadTotal: number;
  connectionsDownloadTotal: number;
  rules: RuleItem[];
  logs: LogMessage[];
  currentTab: string;
}

type Listener = (state: AppState) => void;

class StateStore {
  private state: AppState = {
    authenticated: false,
    status: null,
    mode: "rule",
    traffic: {
      up: 0,
      down: 0,
      historyUp: Array(30).fill(0),
      historyDown: Array(30).fill(0),
    },
    proxies: {},
    proxyGroups: [],
    connections: [],
    connectionsUploadTotal: 0,
    connectionsDownloadTotal: 0,
    rules: [],
    logs: [],
    currentTab: "overview",
  };

  private listeners: Set<Listener> = new Set();

  getState(): Readonly<AppState> {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  setAuthenticated(value: boolean): void {
    this.state.authenticated = value;
    this.notify();
  }

  setTab(tab: string): void {
    this.state.currentTab = tab;
    this.notify();
  }

  setStatus(status: SashStatus): void {
    this.state.status = status;
    this.notify();
  }

  setMode(mode: OutboundMode): void {
    this.state.mode = mode;
    this.notify();
  }

  setConfigs(configs: ConfigsResponse): void {
    this.state.mode = configs.mode;
    this.notify();
  }

  setProxies(proxies: Record<string, ProxyItem>): void {
    this.state.proxies = proxies;
    const groupTypes = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Relay"]);
    this.state.proxyGroups = Object.keys(proxies).filter(
      (name) => groupTypes.has(proxies[name]?.type ?? "") || Array.isArray(proxies[name]?.all),
    );
    this.notify();
  }

  updateProxyDelay(name: string, delay: number): void {
    const item = this.state.proxies[name];
    if (item) {
      if (!item.history) item.history = [];
      item.history.push({ time: new Date().toISOString(), delay });
      this.notify();
    }
  }

  setConnections(connections: ConnectionItem[], uploadTotal: number, downloadTotal: number): void {
    this.state.connections = connections;
    this.state.connectionsUploadTotal = uploadTotal;
    this.state.connectionsDownloadTotal = downloadTotal;
    this.notify();
  }

  setRules(rules: RuleItem[]): void {
    this.state.rules = rules;
    this.notify();
  }

  addTraffic(msg: TrafficMessage): void {
    this.state.traffic.up = msg.up;
    this.state.traffic.down = msg.down;
    this.state.traffic.historyUp.push(msg.up);
    this.state.traffic.historyDown.push(msg.down);
    if (this.state.traffic.historyUp.length > 30) this.state.traffic.historyUp.shift();
    if (this.state.traffic.historyDown.length > 30) this.state.traffic.historyDown.shift();
    this.notify();
  }

  addLog(msg: LogMessage): void {
    this.state.logs.push(msg);
    if (this.state.logs.length > 500) this.state.logs.shift();
    this.notify();
  }
}

export const store = new StateStore();
