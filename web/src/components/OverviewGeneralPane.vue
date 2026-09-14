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
        </span>
      </div>
    </div>

    <ModeControl :is-core-ready="isCoreReady" />

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
            {{ store.status?.core.running && store.status.configuration.appliedSettings ? `127.0.0.1:${store.status.configuration.appliedSettings.mixedPort}` : '-' }}
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
        <span v-if="isCoreReady" class="live-state">
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
import { coreVersion } from "../composables/core-runtime.js";
import { t } from "../i18n/index.js";
import { navigate } from "../router.js";
import {
  errorText,
  isCoreReady,
  store,
  toast,
  updateProfile,
} from "../stores/index.js";
import { formatBytes, formatDuration, formatSpeed } from "../utils/format.js";
import Icon from "./Icon.vue";
import ModeControl from "./ModeControl.vue";
import TrafficChart from "./TrafficChart.vue";

const refreshingSub = ref(false);
const uptime = computed(() => formatDuration(store.status?.core.startedAt));
const activeProfile = computed(() => {
  const applied = store.status?.configuration.appliedProfile;
  return applied ? store.profiles.find((profile) => profile.id === applied.id) ?? applied : null;
});
const totalNodes = computed(
  () =>
    Object.values(store.proxies).filter(
      (proxy) => !(Array.isArray(proxy.all) && proxy.all.length > 0),
    ).length,
);

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
