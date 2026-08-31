import { api } from "./api.js";
import { store } from "./state.js";
import { renderConnections } from "./views/connections.js";
import { renderLogs } from "./views/logs.js";
import { renderOverview } from "./views/overview.js";
import { renderProxies } from "./views/proxies.js";
import { renderRules } from "./views/rules.js";
import { renderSettings } from "./views/settings.js";
import { renderSubscriptions } from "./views/subscriptions.js";

class App {
  private contentEl: HTMLElement | null = null;
  private unsubTraffic: (() => void) | null = null;
  private unsubLogs: (() => void) | null = null;
  private pollTimer: number | null = null;

  async init(): Promise<void> {
    this.contentEl = document.getElementById("app-content");
    this.setupNav();

    // Check if we have a secret
    const secret = api.getSecret();
    if (!secret) {
      this.showAuthModal();
      return;
    }

    try {
      await this.bootstrap();
    } catch {
      this.showAuthModal();
    }
  }

  private setupNav(): void {
    document.querySelectorAll(".nav-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.preventDefault();
        const tab = (item as HTMLElement).dataset.tab;
        if (tab) {
          store.setTab(tab);
          this.updateNavUI(tab);
        }
      });
    });

    store.subscribe((state) => {
      this.updateHeaderStats(state);
      this.renderCurrentView();
    });
  }

  private updateNavUI(activeTab: string): void {
    document.querySelectorAll(".nav-item").forEach((item) => {
      if ((item as HTMLElement).dataset.tab === activeTab) {
        item.classList.add("active");
      } else {
        item.classList.remove("active");
      }
    });
  }

  private updateHeaderStats(state: ReturnType<typeof store.getState>): void {
    const sysproxyBadge = document.getElementById("header-sysproxy-badge");
    if (sysproxyBadge) {
      const isSysProxy = state.status?.systemProxy.applied ?? false;
      sysproxyBadge.textContent = isSysProxy ? "SYS PROXY ON" : "SYS PROXY OFF";
      sysproxyBadge.className = `badge ${isSysProxy ? "badge-success" : "badge-neutral"}`;
    }

    const modeBadge = document.getElementById("header-mode-badge");
    if (modeBadge) {
      modeBadge.textContent = state.mode.toUpperCase();
    }
  }

  private renderCurrentView(): void {
    if (!this.contentEl) return;
    const state = store.getState();

    switch (state.currentTab) {
      case "overview":
        renderOverview(this.contentEl, state);
        break;
      case "proxies":
        renderProxies(this.contentEl, state);
        break;
      case "subscriptions":
        renderSubscriptions(this.contentEl, state);
        break;
      case "connections":
        renderConnections(this.contentEl, state);
        break;
      case "rules":
        renderRules(this.contentEl, state);
        break;
      case "settings":
        renderSettings(this.contentEl, state);
        break;
      case "logs":
        renderLogs(this.contentEl, state);
        break;
      default:
        renderOverview(this.contentEl, state);
    }
  }

  private showAuthModal(): void {
    const modal = document.getElementById("auth-modal");
    if (modal) modal.style.display = "flex";

    const form = document.getElementById("auth-form") as HTMLFormElement;
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("auth-secret-input") as HTMLInputElement;
      const secret = input.value.trim();
      if (!secret) return;

      api.setSecret(secret);
      try {
        await this.bootstrap();
        if (modal) modal.style.display = "none";
      } catch (err) {
        alert(`Authentication failed: ${(err as Error).message}`);
      }
    });
  }

  private async bootstrap(): Promise<void> {
    // 1. Test connection and load initial state
    const [status, configs] = await Promise.all([api.getStatus(), api.getConfigs()]);

    store.setStatus(status);
    store.setConfigs(configs);
    store.setAuthenticated(true);

    // 2. Load proxies & rules in background
    Promise.all([api.getProxies(), api.getRules()])
      .then(([proxiesRes, rulesRes]) => {
        store.setProxies(proxiesRes.proxies);
        store.setRules(rulesRes.rules);
      })
      .catch(() => {
        // core might not have proxies yet
      });

    // 3. Connect real-time WebSocket streams
    this.unsubTraffic?.();
    this.unsubTraffic = api.connectTrafficStream((traffic) => {
      store.addTraffic(traffic);
    });

    this.unsubLogs?.();
    this.unsubLogs = api.connectLogsStream((log) => {
      store.addLog(log);
    });

    // 4. Set up periodic polling for status and connections
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        const [latestStatus, connRes] = await Promise.all([
          api.getStatus(),
          api.getConnections().catch(() => ({ connections: [], uploadTotal: 0, downloadTotal: 0 })),
        ]);
        store.setStatus(latestStatus);
        store.setConnections(connRes.connections, connRes.uploadTotal, connRes.downloadTotal);
      } catch {
        // transient network blips
      }
    }, 2500);
  }
}

const app = new App();
window.addEventListener("DOMContentLoaded", () => app.init());
