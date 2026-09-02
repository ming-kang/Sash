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
  width: 100%;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--bg-app);
}

.app-main {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  background: var(--bg-app);
}

.offline-banner {
  z-index: 15;
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  gap: 7px;
  padding: 6px 18px;
  background: var(--warning-soft);
  border-bottom: 1px solid var(--warning-border);
  color: var(--warning);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
}

.page-container {
  width: 100%;
  min-height: 0;
  flex: 1;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0 clamp(24px, 3.4vw, 52px) 48px;
}

@media (max-width: 899px) {
  .app-shell {
    height: auto;
    min-height: 100vh;
    min-height: 100dvh;
    overflow: visible;
    flex-direction: column;
  }
  .app-main {
    min-height: calc(100dvh - 58px);
    overflow: visible;
  }
  .offline-banner {
    position: sticky;
    top: 58px;
  }
  .page-container {
    overflow: visible;
    padding: 0 16px calc(78px + env(safe-area-inset-bottom));
  }
}

@media (max-width: 480px) {
  .page-container {
    padding-right: 12px;
    padding-left: 12px;
  }
}
</style>
