<template>
  <div class="app-shell">
    <AppSidebar />

    <main class="app-main">
      <Transition name="fade">
        <div v-if="!store.daemonOnline" class="offline-banner">
          <Icon name="alert" :size="13" />
          <span>{{ t('status.offline') }}</span>
        </div>
      </Transition>

      <div class="page-container">
        <OverviewView v-if="currentRoute === 'overview'" />
        <ConnectionsView v-else-if="currentRoute === 'connections'" />
        <RulesView v-else-if="currentRoute === 'rules'" />
        <SubscriptionView v-else-if="currentRoute === 'subscription'" />
        <LogsView v-else-if="currentRoute === 'logs'" />
        <SettingsView v-else-if="currentRoute === 'settings'" />
      </div>
    </main>

    <ToastHost />
    <ConfirmDialog />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { api } from "./api/index.js";
import AppSidebar from "./components/AppSidebar.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import Icon from "./components/Icon.vue";
import ToastHost from "./components/ToastHost.vue";
import { t } from "./i18n/index.js";
import { currentRoute } from "./router.js";
import { addLog, addTraffic, setProxies, store } from "./stores/index.js";
import ConnectionsView from "./views/ConnectionsView.vue";
import LogsView from "./views/LogsView.vue";
import OverviewView from "./views/OverviewView.vue";
import RulesView from "./views/RulesView.vue";
import SettingsView from "./views/SettingsView.vue";
import SubscriptionView from "./views/SubscriptionView.vue";

let pollTimer: number | null = null;
let unsubTraffic: (() => void) | null = null;
let unsubLogs: (() => void) | null = null;

async function pollOnce(): Promise<void> {
  try {
    const [status, conn] = await Promise.all([
      api.getStatus(),
      api.getConnections().catch(() => ({
        connections: [],
        uploadTotal: 0,
        downloadTotal: 0,
      })),
    ]);
    store.status = status;
    store.daemonOnline = true;
    store.connections = conn.connections;
    store.connectionsUploadTotal = conn.uploadTotal;
    store.connectionsDownloadTotal = conn.downloadTotal;
  } catch {
    store.daemonOnline = false;
  }
}

async function bootstrap(): Promise<void> {
  const [status, configs] = await Promise.all([
    api.getStatus().catch(() => null),
    api.getConfigs().catch(() => null),
  ]);

  store.daemonOnline = status !== null;
  if (status) store.status = status;
  if (configs) store.mode = configs.mode;

  Promise.all([api.getProxies(), api.getRules()])
    .then(([p, r]) => {
      setProxies(p.proxies);
      store.rules = r.rules;
    })
    .catch(() => {});

  unsubTraffic = api.connectTraffic((msg) => addTraffic(msg));
  unsubLogs = api.connectLogs((msg) => addLog(msg));

  pollTimer = window.setInterval(() => {
    void pollOnce();
  }, 2000);
}

onMounted(() => {
  void bootstrap();
});

onUnmounted(() => {
  if (pollTimer !== null) clearInterval(pollTimer);
  unsubTraffic?.();
  unsubLogs?.();
});
</script>

<style scoped>
.app-shell {
  display: flex;
  min-height: 100vh;
}

.app-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.offline-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  background: var(--warning-soft);
  border-bottom: 1px solid #fde6b5;
  color: var(--warning);
  font-size: 12.5px;
  font-weight: 500;
  padding: 7px 16px;
}

.page-container {
  flex: 1;
  width: 100%;
  max-width: 1060px;
  margin: 0 auto;
  padding: 24px 28px 48px;
}

@media (max-width: 900px) {
  .app-shell {
    flex-direction: column;
  }
  .page-container {
    padding: 18px 16px 40px;
  }
}
</style>
