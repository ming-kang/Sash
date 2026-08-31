<template>
  <div class="app-container">
    <!-- Top Navigation Bar -->
    <header class="top-nav">
      <div class="nav-brand">
        <span class="brand-logo">⚡</span>
        <span class="brand-name">Sash</span>
      </div>

      <!-- Navigation Tabs -->
      <nav class="nav-menu">
        <button
          v-for="tab in navTabs"
          :key="tab.id"
          class="nav-tab"
          :class="{ active: store.currentTab === tab.id }"
          @click="store.currentTab = tab.id"
        >
          <Icon :name="tab.icon" size="15" />
          <span>{{ tab.name }}</span>
        </button>
      </nav>

      <!-- Status Indicators -->
      <div class="nav-right">
        <div class="live-speed-badges">
          <span class="speed-pill text-success">
            <Icon name="download" size="12" />
            <span>{{ formatSpeed(store.traffic.down) }}</span>
          </span>
          <span class="speed-pill text-sky">
            <Icon name="upload" size="12" />
            <span>{{ formatSpeed(store.traffic.up) }}</span>
          </span>
        </div>

        <span class="badge" :class="isSysProxyOn ? 'badge-success' : 'badge-neutral'">
          {{ isSysProxyOn ? 'SYS PROXY ON' : 'SYS PROXY OFF' }}
        </span>

        <span class="badge badge-primary">
          {{ store.mode.toUpperCase() }}
        </span>
      </div>
    </header>

    <!-- Main View Content -->
    <main class="main-body">
      <div class="view-wrapper">
        <OverviewView v-if="store.currentTab === 'overview'" />
        <ProxiesView v-else-if="store.currentTab === 'proxies'" />
        <SubscriptionsView v-else-if="store.currentTab === 'subscriptions'" />
        <ConnectionsView v-else-if="store.currentTab === 'connections'" />
        <RulesView v-else-if="store.currentTab === 'rules'" />
        <LogsView v-else-if="store.currentTab === 'logs'" />
        <SettingsView v-else-if="store.currentTab === 'settings'" />
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { api } from "./api/index.js";
import Icon from "./components/Icon.vue";
import { addLog, addTraffic, isSysProxyOn, setProxies, store } from "./stores/index.js";
import ConnectionsView from "./views/ConnectionsView.vue";
import LogsView from "./views/LogsView.vue";
import OverviewView from "./views/OverviewView.vue";
import ProxiesView from "./views/ProxiesView.vue";
import RulesView from "./views/RulesView.vue";
import SettingsView from "./views/SettingsView.vue";
import SubscriptionsView from "./views/SubscriptionsView.vue";

let pollTimer: number | null = null;
let unsubTraffic: (() => void) | null = null;
let unsubLogs: (() => void) | null = null;

const navTabs = [
  { id: "overview", name: "Overview", icon: "activity" },
  { id: "proxies", name: "Proxies", icon: "globe" },
  { id: "subscriptions", name: "Subscriptions", icon: "link" },
  { id: "connections", name: "Connections", icon: "layers" },
  { id: "rules", name: "Rules", icon: "filter" },
  { id: "settings", name: "Settings", icon: "settings" },
  { id: "logs", name: "Logs", icon: "terminal" },
];

function formatSpeed(bytes: number): string {
  if (bytes === 0) return "0 B/s";
  const k = 1024;
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

async function bootstrap(): Promise<void> {
  const [status, configs] = await Promise.all([
    api.getStatus().catch(() => null),
    api.getConfigs().catch(() => ({ mode: "rule" as const })),
  ]);

  if (status) store.status = status;
  if (configs) store.mode = configs.mode;
  store.authenticated = true;

  // Background fetch proxies & rules
  Promise.all([api.getProxies(), api.getRules()])
    .then(([pRes, rRes]) => {
      setProxies(pRes.proxies);
      store.rules = rRes.rules;
    })
    .catch(() => {});

  // WebSockets
  unsubTraffic?.();
  unsubTraffic = api.connectTrafficStream((t) => addTraffic(t));

  unsubLogs?.();
  unsubLogs = api.connectLogsStream((l) => addLog(l));

  // Polling loop
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = window.setInterval(async () => {
    try {
      const [newStatus, cRes] = await Promise.all([
        api.getStatus(),
        api.getConnections().catch(() => ({ connections: [], uploadTotal: 0, downloadTotal: 0 })),
      ]);
      store.status = newStatus;
      store.connections = cRes.connections;
      store.connectionsUploadTotal = cRes.uploadTotal;
      store.connectionsDownloadTotal = cRes.downloadTotal;
    } catch {
      // transient
    }
  }, 2000);
}

onMounted(() => {
  bootstrap();
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  unsubTraffic?.();
  unsubLogs?.();
});
</script>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.top-nav {
  height: 56px;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border-card);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  position: sticky;
  top: 0;
  z-index: 40;
}

.brand-logo {
  font-size: 18px;
}

.brand-name {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.nav-menu {
  display: flex;
  align-items: center;
  gap: 2px;
}

.nav-tab {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-secondary);
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.15s ease;
}

.nav-tab:hover {
  color: var(--text-primary);
  background: #1f2937;
}

.nav-tab.active {
  color: #38bdf8;
  background: rgba(2, 132, 199, 0.12);
  border-color: rgba(2, 132, 199, 0.3);
}

.nav-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.live-speed-badges {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-input);
  border: 1px solid var(--border-card);
  padding: 3px 8px;
  border-radius: var(--radius-sm);
}

.speed-pill {
  display: flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 600;
}

.text-success {
  color: var(--color-success);
}
.text-sky {
  color: #38bdf8;
}

.main-body {
  flex: 1;
  padding: 20px;
}

.view-wrapper {
  max-width: 1140px;
  margin: 0 auto;
}
</style>
