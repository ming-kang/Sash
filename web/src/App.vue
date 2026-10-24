<template>
  <div class="app-frame">
    <div class="app-shell">
      <AppSidebar />

      <main class="app-main">
        <Transition name="fade">
          <div
            v-if="bannerNotice"
            class="runtime-banner"
            :class="bannerNotice"
            role="status"
            aria-live="polite"
          >
            <Icon name="alert" :size="13" />
            <span>
              {{ t(`status.${bannerNotice}`) }}
              <span v-if="coreSnapshotError" class="snapshot-error">{{ coreSnapshotError }}</span>
            </span>
          </div>
        </Transition>

        <div class="app-chrome">
          <div
            v-if="sessionReady && store.status?.configuration.pending"
            class="pending-config"
            role="status"
          >
            <span>{{ t('settings.pendingApply') }}</span>
            <CoreControls apply-only />
          </div>

          <ToastHost />
        </div>

        <div
          ref="pageContainer"
          class="page-container"
          :class="`page-${sessionReady ? currentRoute : 'connect'}`"
        >
          <ConnectionView v-if="!sessionReady" />
          <OverviewView v-else-if="currentRoute === 'overview'" />
          <ProfilesView v-else-if="currentRoute === 'profiles'" />
          <LogsView v-else-if="currentRoute === 'logs'" />
          <ConnectionsView v-else-if="currentRoute === 'connections'" />
          <RulesView v-else-if="currentRoute === 'rules'" />
          <SettingsView v-else-if="currentRoute === 'settings'" />
        </div>
      </main>

      <ConfirmDialog />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { api, sessionReady } from "./api/index.js";
import AppSidebar from "./components/AppSidebar.vue";
import { asyncView } from "./components/async-view.js";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import CoreControls from "./components/CoreControls.vue";
import Icon from "./components/Icon.vue";
import ToastHost from "./components/ToastHost.vue";
import { t } from "./i18n/index.js";
import { currentRoute } from "./router.js";
import {
  addLog,
  coreSnapshotError,
  isCoreReady,
  runtimeNotice,
  startRuntimeEvents,
  startTrafficEvents,
  store,
} from "./stores/index.js";
import OverviewView from "./views/OverviewView.vue";
import ConnectionView from "./views/ConnectionView.vue";

const bannerNotice = computed(() =>
  store.daemonOnline && !sessionReady.value ? "unauthorized" : runtimeNotice.value,
);

const ConnectionsView = asyncView(() => import("./views/ConnectionsView.vue"));
const LogsView = asyncView(() => import("./views/LogsView.vue"));
const ProfilesView = asyncView(() => import("./views/ProfilesView.vue"));
const RulesView = asyncView(() => import("./views/RulesView.vue"));
const SettingsView = asyncView(() => import("./views/SettingsView.vue"));

let stopRuntime: (() => void) | null = null;
let stopTraffic: (() => void) | null = null;
let unsubLogs: (() => void) | null = null;
const visible = ref(!document.hidden);
const pageContainer = ref<HTMLElement | null>(null);
const updateVisibility = () => { visible.value = !document.hidden; };

watch(currentRoute, () => {
  if (pageContainer.value) pageContainer.value.scrollTop = 0;
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
});

const scrollIdleTimers = new WeakMap<Element, number>();

function handleScrollCapture(event: Event): void {
  const target = event.target instanceof Document ? document.documentElement : event.target;
  if (!(target instanceof HTMLElement)) return;
  target.classList.add("is-scrolling");
  const previous = scrollIdleTimers.get(target);
  if (previous !== undefined) window.clearTimeout(previous);
  scrollIdleTimers.set(
    target,
    window.setTimeout(() => {
      target.classList.remove("is-scrolling");
      scrollIdleTimers.delete(target);
    }, 700),
  );
}

function stopLogs(): void {
  unsubLogs?.();
  unsubLogs = null;
}

watch(
  () =>
    visible.value && store.daemonOnline &&
    isCoreReady.value &&
    sessionReady.value &&
    currentRoute.value === "logs"
      ? store.runtimeGeneration
      : null,
  (generation) => {
    unsubLogs?.();
    unsubLogs = null;
    if (generation === null) return;
    unsubLogs = api.connectLogs((message) => addLog(message, generation));
  },
);

onMounted(() => {
  document.addEventListener("visibilitychange", updateVisibility);
  stopTraffic = startTrafficEvents();
  stopRuntime = startRuntimeEvents();
  window.addEventListener("scroll", handleScrollCapture, { capture: true, passive: true });
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", updateVisibility);
  stopRuntime?.();
  stopTraffic?.();
  stopLogs();
  window.removeEventListener("scroll", handleScrollCapture, { capture: true });
});
</script>

<style scoped>
.app-chrome {
  position: relative;
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
}
.pending-config {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 24px;
  color: var(--warning);
  background: var(--warning-soft);
  border-bottom: 1px solid var(--warning-border);
  font-size: 14px;
}
.app-frame {
  width: 100%;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--bg-app);
}
.app-shell {
  display: flex;
  width: 100%;
  height: 100%;
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
  position: relative;
  z-index: var(--z-banner);
  display: flex;
  flex-shrink: 0;
  min-height: 30px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 5px 18px;
  background: var(--danger-soft);
  border-bottom: 1px solid var(--danger-border);
  color: var(--danger);
  font-size: 13px;
  font-weight: 600;
  text-align: center;
}
.runtime-banner.coreDegraded,
.runtime-banner.coreUnavailable {
  background: var(--warning-soft);
  border-bottom-color: var(--warning-border);
  color: var(--warning);
}
.snapshot-error {
  display: block;
  overflow-wrap: anywhere;
  font-weight: 400;
}
.page-container {
  --page-gutter: 30px;
  width: 100%;
  min-height: 0;
  flex: 1;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0 var(--page-gutter) 40px;
}
.page-container.page-overview {
  --page-gutter: 30px;
}
@media (min-width: 821px) {
  .page-container.page-overview {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
}
.page-container.page-logs,
.page-container.page-connections {
  --page-gutter: 0px;
  padding-right: 0;
  padding-bottom: 0;
  padding-left: 0;
}

@media (max-width: 899px) {
  .app-frame {
    height: auto;
    min-height: 100vh;
    min-height: 100dvh;
    overflow: visible;
  }
  .app-shell {
    height: auto;
    min-height: 100dvh;
    overflow: visible;
    flex-direction: column;
  }
  .app-main {
    min-height: 100dvh;
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
    --page-gutter: 16px;
    overflow: visible;
    padding: 0 var(--page-gutter) calc(78px + env(safe-area-inset-bottom));
  }
  .page-container.page-logs {
    padding-bottom: 8px;
  }
}

@media (max-width: 480px) {
  .page-container,
  .page-container.page-overview,
  .page-container.page-profiles,
  .page-container.page-logs,
  .page-container.page-connections {
    --page-gutter: 12px;
    padding-right: var(--page-gutter);
    padding-left: var(--page-gutter);
  }
}
</style>
