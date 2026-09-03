<template>
  <div class="app-frame">
    <header class="app-titlebar">
      <span>Sash</span>
    </header>

    <div class="app-shell">
      <AppSidebar />

      <main class="app-main">
        <Transition name="fade">
          <div
            v-if="runtimeNotice"
            class="runtime-banner"
            :class="runtimeNotice"
            role="status"
            aria-live="polite"
            :title="store.coreSnapshotError ?? undefined"
          >
            <Icon name="alert" :size="13" />
            <span>{{ t(`status.${runtimeNotice}`) }}</span>
          </div>
        </Transition>

        <div
          class="page-container"
          :class="[`page-${currentRoute}`, { 'has-runtime-banner': runtimeNotice }]"
        >
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
  runtimeNotice,
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
  () =>
    store.daemonOnline && isCoreReady.value && api.hasSession()
      ? store.runtimeGeneration
      : null,
  (generation) => {
    stopStreams();
    if (generation === null) return;
    unsubTraffic = api.connectTraffic(
      (message) => addTraffic(message, generation),
      () => {
        if (generation === store.runtimeGeneration) resetTraffic();
      },
    );
    unsubLogs = api.connectLogs((message) => addLog(message, generation));
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
.app-frame {
  width: 100%;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--bg-app);
}
.app-titlebar {
  position: relative;
  z-index: 30;
  display: flex;
  width: 100%;
  height: 25px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--bg-titlebar);
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1;
  user-select: none;
}
.app-shell {
  display: flex;
  width: 100%;
  height: calc(100vh - 25px);
  height: calc(100dvh - 25px);
  overflow: hidden;
  background: var(--bg-app);
}
.app-main {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  background: var(--bg-app);
}
.runtime-banner {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  z-index: 15;
  display: flex;
  min-height: 30px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 5px 18px;
  background: var(--danger-soft);
  border-bottom: 1px solid var(--danger-border);
  color: var(--danger);
  font-size: 11px;
  font-weight: 600;
  text-align: center;
}
.runtime-banner.coreDegraded,
.runtime-banner.coreUnavailable {
  background: var(--warning-soft);
  border-bottom-color: var(--warning-border);
  color: var(--warning);
}
.page-container {
  width: 100%;
  min-height: 0;
  flex: 1;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0 30px 44px;
}
.page-container.page-overview {
  padding-right: 34px;
  padding-left: 34px;
}
.page-container.page-profiles {
  padding: 0;
}
.page-container.has-runtime-banner {
  padding-top: 30px;
}
.page-container.page-logs,
.page-container.page-connections {
  padding-right: 0;
  padding-bottom: 0;
  padding-left: 0;
}

@media (max-width: 899px) {
  .app-titlebar {
    height: 40px;
    justify-content: flex-start;
    padding: 0 14px;
    font-size: 14px;
    font-weight: 600;
  }
  .app-frame {
    height: auto;
    min-height: 100vh;
    min-height: 100dvh;
    overflow: visible;
  }
  .app-shell {
    height: auto;
    min-height: calc(100dvh - 40px);
    overflow: visible;
    flex-direction: column;
  }
  .app-main {
    min-height: calc(100dvh - 40px);
    overflow: visible;
  }
  .runtime-banner {
    position: sticky;
    top: 0;
  }
  .page-container,
  .page-container.page-overview,
  .page-container.page-profiles,
  .page-container.page-logs,
  .page-container.page-connections {
    overflow: visible;
    padding: 0 16px calc(78px + env(safe-area-inset-bottom));
  }
  .page-container.page-logs {
    padding-bottom: 8px;
  }
  .page-container.has-runtime-banner {
    padding-top: 0;
  }
}

@media (max-width: 480px) {
  .page-container,
  .page-container.page-overview,
  .page-container.page-profiles,
  .page-container.page-logs,
  .page-container.page-connections {
    padding-right: 12px;
    padding-left: 12px;
  }
}
</style>
