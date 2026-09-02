<template>
  <div class="app-shell">
    <AppSidebar />

    <main class="app-main">
      <Transition name="fade">
        <div v-if="!store.daemonOnline" class="offline-banner" role="status" aria-live="polite">
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
import { onMounted, onUnmounted, watch } from "vue";
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
  isCoreReady,
  resetTraffic,
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

function stopStreams(): void {
  unsubTraffic?.();
  unsubLogs?.();
  unsubTraffic = null;
  unsubLogs = null;
  resetTraffic();
}

watch(
  () => store.daemonOnline && isCoreReady.value && api.hasSession(),
  (available) => {
    if (!available) {
      stopStreams();
      return;
    }
    if (!unsubTraffic) unsubTraffic = api.connectTraffic(addTraffic, resetTraffic);
    if (!unsubLogs) unsubLogs = api.connectLogs(addLog);
  },
);

onMounted(() => {
  stopPolling = startRuntimePolling();
});

onUnmounted(() => {
  stopPolling?.();
  stopStreams();
});
</script>

<style scoped>
.app-shell {
  display: flex;
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--bg-app);
}

.app-main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.offline-banner {
  position: sticky;
  top: 0;
  z-index: 15;
  display: flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 7px 18px;
  background: var(--warning-soft);
  border-bottom: 1px solid var(--warning-border);
  color: var(--warning);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
}

.page-container {
  width: 100%;
  max-width: 1440px;
  flex: 1;
  margin: 0 auto;
  padding: 30px clamp(24px, 3vw, 48px) 56px;
}

@media (max-width: 899px) {
  .app-shell {
    flex-direction: column;
  }
  .offline-banner {
    top: 60px;
  }
  .page-container {
    padding: 20px 16px calc(82px + env(safe-area-inset-bottom));
  }
}

@media (max-width: 480px) {
  .page-container {
    padding-right: 12px;
    padding-left: 12px;
  }
}
</style>
