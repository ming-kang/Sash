<template>
  <aside class="general-pane" :aria-label="t('overview.coreTitle')">
    <div class="identity-row">
      <span class="identity-mark" aria-hidden="true">
        <img :src="'./assets/branding/sash-cat.png'" alt="" />
      </span>
      <div class="identity-copy">
        <h2>Sash</h2>
        <span class="identity-meta mono">
          <template v-if="coreVersion">{{ coreVersion }}</template>
          <template v-if="coreVersion && store.status?.core.pid"> · </template>
          <template v-if="store.status?.core.pid">PID {{ store.status.core.pid }}</template>
        </span>
      </div>
    </div>

    <section class="mode-control" :aria-label="t('overview.modeTitle')">
      <div class="mode-switcher" role="group" :aria-label="t('overview.modeTitle')">
        <button
          v-for="mode in modes"
          :key="mode.id"
          type="button"
          class="mode-button"
          :class="{ active: store.mode === mode.id }"
          :aria-pressed="store.mode === mode.id"
          :disabled="store.operations.mode || !isCoreReady"
          @click="switchMode(mode.id)"
        >
          <span class="mode-code">{{ mode.id.toUpperCase() }}</span>
          <span class="mode-name">{{ mode.label }}</span>
        </button>
      </div>
      <div class="mode-switcher toggle-switcher" role="group" :aria-label="t('overview.switchesTitle')">
        <button
          type="button"
          class="mode-button toggle-button"
          :class="{ active: isSysProxyOn }"
          :aria-pressed="isSysProxyOn"
          :disabled="!canToggleSystemProxy"
          @click="toggleSystemProxy(!isSysProxyOn)"
        >
          <span class="toggle-name">{{ t('overview.sysProxyTitle') }}</span>
          <span class="toggle-state">{{ isSysProxyOn ? t('common.on') : t('common.off') }}</span>
        </button>
        <button
          type="button"
          class="mode-button toggle-button"
          :class="{ active: allowLanOn }"
          :aria-pressed="allowLanOn"
          :disabled="store.operations.networkSetting || !store.status"
          @click="applyNetToggle('allow-lan', !allowLanOn)"
        >
          <span class="toggle-name">{{ t('overview.lan') }}</span>
          <span class="toggle-state">{{ allowLanOn ? t('common.on') : t('common.off') }}</span>
        </button>
        <button
          type="button"
          class="mode-button toggle-button"
          :class="{ active: tunOn }"
          :aria-pressed="tunOn"
          :disabled="store.operations.networkSetting || !store.status"
          @click="applyNetToggle('tun', !tunOn)"
        >
          <span class="toggle-name">{{ t('overview.tun') }}</span>
          <span class="toggle-state" :class="tunStateClass" :title="tunStatusBadge?.title">
            {{ tunOn ? (tunStatusBadge?.text ?? t('common.on')) : t('common.off') }}
          </span>
        </button>
      </div>
    </section>

    <div class="general-list">
      <div class="general-row">
        <div class="general-label">{{ t('overview.uptime') }}</div>
        <div class="general-value mono">{{ uptime }}</div>
      </div>

      <div class="general-row">
        <div class="general-label">{{ t('overview.mixedPort') }}</div>
        <div class="general-value">
          <button
            type="button"
            class="general-link mono"
            :title="t('page.settings.title')"
            @click="navigate('settings')"
          >
            127.0.0.1:{{ store.status?.settings.mixedPort ?? 17890 }}
          </button>
        </div>
      </div>

      <div class="general-row profile-row">
        <div class="general-label">
          <span>{{ t('overview.subTitle') }}</span>
          <small v-if="activeProfile">{{ t('common.nodesCount', { n: totalNodes }) }}</small>
        </div>
        <div v-if="activeProfile" class="general-value profile-value">
          <button
            type="button"
            class="general-link profile-name"
            :title="activeProfile.url || activeProfile.name"
            @click="navigate('profiles')"
          >
            {{ activeProfile.name }}
          </button>
          <button
            v-if="activeProfile.url"
            type="button"
            class="icon-btn"
            :class="{ spin: refreshingSub }"
            :title="t('profiles.update')"
            :aria-label="t('profiles.update')"
            :disabled="refreshingSub"
            @click="refreshActiveProfile"
          >
            <Icon name="refresh" :size="14" />
          </button>
        </div>
        <button v-else type="button" class="btn btn-primary btn-sm" @click="navigate('profiles')">
          {{ t('overview.subSet') }}
        </button>
      </div>
    </div>

    <section class="traffic-compact" :aria-label="t('overview.trafficTitle')">
      <div class="pane-section-heading traffic-heading">
        <div>
          <h3>{{ t('overview.trafficTitle') }}</h3>
          <p>
            {{ t('connections.active') }}
            <strong class="mono">{{ store.connections.length }}</strong>
          </p>
        </div>
        <span class="live-state">
          <span class="dot dot-success" />
          {{ t('common.live') }}
        </span>
      </div>
      <div class="traffic-metrics">
        <div class="traffic-metric">
          <span>{{ t('overview.download') }}</span>
          <strong class="mono down-value">{{ formatSpeed(store.traffic.down) }}</strong>
        </div>
        <div class="traffic-metric">
          <span>{{ t('overview.upload') }}</span>
          <strong class="mono up-value">{{ formatSpeed(store.traffic.up) }}</strong>
        </div>
      </div>
      <TrafficChart
        :down="store.traffic.historyDown"
        :up="store.traffic.historyUp"
        :height="74"
        :label="t('overview.trafficTitle')"
      />
      <div class="traffic-totals">
        <span>
          {{ t('overview.totalDown') }}
          <strong class="mono">{{ formatBytes(store.connectionsDownloadTotal) }}</strong>
        </span>
        <span>
          {{ t('overview.totalUp') }}
          <strong class="mono">{{ formatBytes(store.connectionsUploadTotal) }}</strong>
        </span>
      </div>
    </section>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { coreVersion, tunStatusBadge } from "../composables/core-runtime.js";
import { locale, t } from "../i18n/index.js";
import { navigate } from "../router.js";
import {
  canToggleSystemProxy,
  errorText,
  isCoreReady,
  isSysProxyOn,
  patchBooleanSetting,
  setOutboundMode,
  setSystemProxyEnabled,
  store,
  toast,
  updateProfile,
} from "../stores/index.js";
import type { OutboundMode } from "../types/index.js";
import { formatBytes, formatDuration, formatSpeed } from "../utils/format.js";
import Icon from "./Icon.vue";
import TrafficChart from "./TrafficChart.vue";

const refreshingSub = ref(false);
const uptime = computed(() => formatDuration(store.status?.core.startedAt, locale.value));
const activeProfile = computed(() => store.status?.activeProfile ?? null);
const allowLanOn = computed(() => store.status?.settings.allowLan ?? false);
const tunOn = computed(() => store.status?.settings.tun ?? false);
const tunStateClass = computed(() => {
  const name = tunStatusBadge.value?.className;
  if (name === "badge-success") return "state-ok";
  if (name === "badge-warning" || name === "badge-danger") return "state-warn";
  return undefined;
});
const totalNodes = computed(
  () =>
    Object.values(store.proxies).filter(
      (proxy) => !(Array.isArray(proxy.all) && proxy.all.length > 0),
    ).length,
);
const modes = computed(() => [
  { id: "global" as OutboundMode, label: t("overview.modeGlobal") },
  { id: "rule" as OutboundMode, label: t("overview.modeRule") },
  { id: "direct" as OutboundMode, label: t("overview.modeDirect") },
]);

async function switchMode(mode: OutboundMode): Promise<void> {
  if (mode === store.mode) return;
  try {
    await setOutboundMode(mode);
    toast.success(
      t("toast.modeOk", {
        mode: t(`overview.mode${mode[0]?.toUpperCase()}${mode.slice(1)}`),
      }),
    );
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}

async function toggleSystemProxy(target: boolean): Promise<void> {
  try {
    await setSystemProxyEnabled(target);
    toast.success(t(target ? "toast.sysProxyOn" : "toast.sysProxyOff"));
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}

async function applyNetToggle(key: "allow-lan" | "tun", next: boolean): Promise<void> {
  try {
    await patchBooleanSetting(key, next);
    toast.success(t("toast.settingSaved"));
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}

async function refreshActiveProfile(): Promise<void> {
  const profile = activeProfile.value;
  if (!profile?.url || refreshingSub.value) return;
  refreshingSub.value = true;
  try {
    await updateProfile(profile.id);
    toast.success(t("toast.profileUpdated", { name: profile.name }));
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    refreshingSub.value = false;
  }
}
</script>

<style scoped>
.general-pane {
  min-width: 0;
  overflow: hidden;
  background: var(--bg-panel);
  border: 0;
  border-radius: 5px;
}
.identity-row {
  display: flex;
  min-height: 88px;
  align-items: center;
  gap: 14px;
  padding: 14px 17px;
  border-bottom: 1px solid var(--border);
}
.identity-mark {
  display: block;
  width: 62px;
  height: 50px;
  flex-shrink: 0;
}
.identity-mark img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.identity-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}
.identity-copy h2 {
  color: var(--general-title);
  font-size: 26px;
  font-weight: 400;
  letter-spacing: -0.03em;
  line-height: 1;
}
.identity-meta {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mode-control,
.traffic-compact {
  padding: 13px 16px 15px;
  border-bottom: 1px solid var(--border);
}
.pane-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 11px;
}
.pane-section-heading h3 {
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 600;
}
.pane-section-heading p {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 14px;
}
.mode-switcher {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}
.mode-button {
  display: flex;
  min-width: 0;
  min-height: 48px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 1px;
  padding: 6px 4px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--mode-button-bg);
  box-shadow: var(--shadow-card);
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard),
    opacity var(--motion-fast) var(--ease-standard);
}
.mode-button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.mode-button.active {
  background: var(--mode-button-active-bg);
  color: var(--mode-button-active-text);
}
.mode-button:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}
.mode-code {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.055em;
}
.mode-name {
  overflow: hidden;
  max-width: 100%;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toggle-switcher {
  margin-top: 13px;
  padding-top: 13px;
  border-top: 1px solid var(--border);
}
.toggle-name {
  overflow: hidden;
  max-width: 100%;
  font-size: 14px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toggle-state {
  font-size: 12px;
  opacity: 0.85;
}
.toggle-button.active .toggle-state {
  color: inherit;
}
.toggle-button:not(.active) .toggle-state.state-ok {
  color: var(--success);
}
.toggle-button:not(.active) .toggle-state.state-warn {
  color: var(--warning);
}
.general-list {
  background: var(--bg-app);
  border-bottom: 1px solid var(--border);
}
.general-row {
  display: flex;
  min-height: 47px;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 7px 15px;
  border-bottom: 1px solid var(--border);
  transition: background var(--motion-fast) var(--ease-standard);
}
.general-row:last-child {
  border-bottom: 0;
}
.general-row:hover {
  background: var(--general-row-hover);
}
.general-label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  color: var(--text-primary);
  font-size: 16px;
}
.general-label small {
  margin-top: 1px;
  color: var(--text-muted);
  font-size: 12px;
}
.general-value {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  color: var(--text-secondary);
  font-size: 14px;
  text-align: right;
}
.general-toggle-value,
.profile-value {
  gap: 7px;
}
.profile-value {
  max-width: 56%;
}
.general-link {
  min-width: 0;
  padding: 0 0 1px;
  overflow: hidden;
  border: 0;
  border-bottom: 1px dashed var(--clickable-border);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: inherit;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    border-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}
.general-link:hover {
  border-bottom-color: var(--text-primary);
  color: var(--text-primary);
}
.profile-name {
  overflow: hidden;
  color: var(--text-primary);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.traffic-compact {
  border-bottom: 0;
}
.traffic-heading {
  margin-bottom: 8px;
}
.live-state {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 6px;
  color: var(--success);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.traffic-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 4px;
}
.traffic-metric {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 12px;
}
.traffic-metric strong {
  overflow: hidden;
  font-size: 14px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.down-value {
  color: var(--chart-down);
}
.up-value {
  color: var(--chart-up);
}
.traffic-totals {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 3px 10px;
  margin-top: 5px;
  color: var(--text-muted);
  font-size: 12px;
}
.traffic-totals strong {
  color: var(--text-secondary);
  font-weight: 500;
}

@media (max-width: 820px) {
  .general-pane {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .identity-row,
  .mode-control {
    border-bottom: 1px solid var(--border);
  }
  .mode-control {
    border-left: 1px solid var(--border);
  }
  .general-list {
    border-bottom: 0;
  }
  .traffic-compact {
    border-left: 1px solid var(--border);
  }
}

@media (max-width: 580px) {
  .general-pane {
    display: block;
  }
  .mode-control,
  .traffic-compact {
    border-left: 0;
  }
  .traffic-compact {
    border-top: 1px solid var(--border);
  }
}

@media (max-width: 420px) {
  .mode-name {
    display: none;
  }
  .mode-button {
    min-height: 44px;
  }
  .general-row {
    min-height: 52px;
    gap: 10px;
    padding-right: 11px;
    padding-left: 11px;
  }
  .general-value {
    max-width: 58%;
  }
  .profile-row {
    align-items: flex-start;
    flex-direction: column;
  }
  .profile-row .general-value,
  .profile-row > .btn {
    width: 100%;
    max-width: none;
  }
  .profile-value {
    justify-content: space-between;
  }
}
</style>
