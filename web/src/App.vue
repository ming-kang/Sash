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
        <ProfilesView v-else-if="currentRoute === 'profiles'" />
        <LogsView v-else-if="currentRoute === 'logs'" />
        <ConnectionsView v-else-if="currentRoute === 'connections'" />
        <RulesView v-else-if="currentRoute === 'rules'" />
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
import {
  addLog,
  addTraffic,
  refreshConnections,
  refreshRuntimeState,
  startRuntimePolling,
  store,
} from "./stores/index.js";
import ConnectionsView from "./views/ConnectionsView.vue";
import LogsView from "./views/LogsView.vue";
import OverviewView from "./views/OverviewView.vue";
import ProfilesView from "./views/ProfilesView.vue";
import RulesView from "./views/RulesView.vue";
import SettingsView from "./views/SettingsView.vue";

let stopPolling: (() => void) | null = null;
let unsubTraffic: (() => void) | null = null;
let unsubLogs: (() => void) | null = null;

async function bootstrap(): Promise<void> {
  try {
    await api.initialize();
    await Promise.all([refreshRuntimeState(), refreshConnections().catch(() => undefined)]);
  } catch {
    store.daemonOnline = false;
  }

  unsubTraffic = api.connectTraffic(addTraffic);
  unsubLogs = api.connectLogs(addLog);
  stopPolling = startRuntimePolling();
}

onMounted(() => {
  void bootstrap();
});

onUnmounted(() => {
  stopPolling?.();
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
