<template>
  <aside class="general-pane" :aria-label="t('overview.coreTitle')">
    <div class="identity-row">
      <span class="identity-mark" aria-hidden="true">
        <svg viewBox="0 0 64 64">
          <rect width="64" height="64" rx="14" fill="var(--general-title)" />
          <path
            d="M42 22.4c-1.4-3.8-5.1-5.9-9.8-5.9-5.7 0-10 3.4-10 8 0 10.5 20.8 5.7 20.8 15.7 0 5-4.6 8.2-10.7 8.2-5.3 0-9.8-2.7-11-6.8"
            fill="none"
            stroke="var(--bg-panel)"
            stroke-width="5"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <div class="identity-copy">
        <div class="identity-title-row">
          <h2>Sash</h2>
          <span v-if="coreVersion" class="identity-version mono">{{ coreVersion }}</span>
        </div>
        <span class="runtime-state" :class="isCoreRunning ? 'is-running' : 'is-stopped'">
          <span class="dot" :class="isCoreRunning ? 'dot-success' : 'dot-danger'" />
          {{ isCoreRunning ? t('common.running') : t('common.stopped') }}
        </span>
      </div>
    </div>

    <section class="mode-control" :aria-label="t('overview.modeTitle')">
      <div class="pane-section-heading">
        <div>
          <h3>{{ t('overview.modeTitle') }}</h3>
          <p>{{ t('overview.modeDesc') }}</p>
        </div>
      </div>
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
    </section>

    <div class="general-list">
      <div class="general-row">
        <div class="general-label">
          <span>{{ t('overview.coreTitle') }}</span>
          <small v-if="store.status?.core.pid" class="mono">PID {{ store.status.core.pid }}</small>
        </div>
        <div class="general-value mono">{{ coreVersion || '-' }}</div>
      </div>

      <div class="general-row">
        <div class="general-label">{{ t('overview.uptime') }}</div>
        <div class="general-value mono">{{ uptime }}</div>
      </div>

      <div class="general-row">
        <div class="general-label">{{ t('overview.sysProxyTitle') }}</div>
        <div class="general-value">
          <UiSwitch
            :model-value="isSysProxyOn"
            :label="t('overview.sysProxyTitle')"
            :disabled="!canToggleSystemProxy"
            @update:model-value="toggleSystemProxy"
          />
        </div>
      </div>

      <div class="general-row">
        <div class="general-label">{{ t('overview.lan') }}</div>
        <div class="general-value">
          <UiSwitch
            :model-value="store.status?.settings.allowLan ?? false"
            :label="t('overview.lan')"
            :disabled="store.operations.networkSetting || !store.status"
            @update:model-value="(value: boolean) => applyNetToggle('allow-lan', value)"
          />
        </div>
      </div>

      <div class="general-row">
        <div class="general-label">{{ t('overview.tun') }}</div>
        <div class="general-value general-toggle-value">
          <span
            v-if="tunStatusBadge"
            class="badge"
            :class="tunStatusBadge.className"
            :title="tunStatusBadge.title"
          >
            {{ tunStatusBadge.text }}
          </span>
          <UiSwitch
            :model-value="store.status?.settings.tun ?? false"
            :label="t('overview.tun')"
            :disabled="store.operations.networkSetting || !store.status"
            @update:model-value="(value: boolean) => applyNetToggle('tun', value)"
          />
        </div>
      </div>

      <div class="general-row">
        <div class="general-label">{{ t('overview.mixedPort') }}</div>
        <div class="general-value mono">
          127.0.0.1:{{ store.status?.settings.mixedPort ?? 17890 }}
        </div>
      </div>

      <div class="general-row profile-row">
        <div class="general-label">
          <span>{{ t('overview.subTitle') }}</span>
          <small v-if="activeProfile">{{ t('common.nodesCount', { n: totalNodes }) }}</small>
        </div>
        <div v-if="activeProfile" class="general-value profile-value">
          <span class="profile-name" :title="activeProfile.url || activeProfile.name">
            {{ activeProfile.name }}
          </span>
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
  isCoreRunning,
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
import UiSwitch from "./UiSwitch.vue";

const refreshingSub = ref(false);
const uptime = computed(() => formatDuration(store.status?.core.startedAt, locale.value));
const activeProfile = computed(() => store.status?.activeProfile ?? null);
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
  --general-title: #2c3e50;
  min-width: 0;
  overflow: hidden;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
:global(html[data-theme="dark"]) .general-pane {
  --general-title: #e5e2e8;
}
.identity-row {
  display: flex;
  min-height: 92px;
  align-items: center;
  gap: 14px;
  padding: 15px 17px;
  border-bottom: 1px solid var(--border);
}
.identity-mark,
.identity-mark svg {
  display: block;
  width: 51px;
  height: 51px;
  flex-shrink: 0;
}
.identity-copy {
  min-width: 0;
  flex: 1;
}
.identity-title-row {
  display: flex;
  align-items: baseline;
  gap: 9px;
}
.identity-title-row h2 {
  color: var(--general-title);
  font-size: 25px;
  font-weight: 400;
  letter-spacing: -0.03em;
  line-height: 1;
}
.identity-version {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.runtime-state {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 9px;
  color: var(--text-secondary);
  font-size: 11px;
}
.runtime-state.is-running {
  color: var(--success);
}
.runtime-state.is-stopped {
  color: var(--danger);
}
.mode-control,
.traffic-compact {
  padding: 14px 16px 16px;
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
  font-size: 13px;
  font-weight: 600;
}
.pane-section-heading p {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 10.5px;
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
  background: var(--bg-elevated);
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
  background: var(--accent);
  color: var(--accent-contrast);
}
.mode-button:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}
.mode-code {
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.055em;
}
.mode-name {
  overflow: hidden;
  max-width: 100%;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.general-list {
  background: color-mix(in srgb, var(--bg-app) 78%, var(--bg-panel));
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
  background: var(--bg-hover);
}
.general-label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  color: var(--text-primary);
  font-size: 12.5px;
}
.general-label small {
  margin-top: 1px;
  color: var(--text-muted);
  font-size: 9px;
}
.general-value {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  color: var(--text-secondary);
  font-size: 10.5px;
  text-align: right;
}
.general-toggle-value,
.profile-value {
  gap: 7px;
}
.profile-value {
  max-width: 56%;
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
  font-size: 9.5px;
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
  font-size: 9.5px;
}
.traffic-metric strong {
  overflow: hidden;
  font-size: 10.5px;
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
  font-size: 9px;
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
