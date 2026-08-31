<template>
  <div>
    <PageHeader :title="t('page.overview.title')" :desc="t('page.overview.desc')" />

    <!-- Live traffic -->
    <UiCard :title="t('overview.trafficTitle')">
      <template #actions>
        <div class="traffic-now">
          <span class="now-item">
            <i class="legend-dot" style="background: var(--chart-down)" />
            {{ t('overview.download') }}
            <b class="mono">{{ formatSpeed(store.traffic.down) }}</b>
          </span>
          <span class="now-item">
            <i class="legend-dot" style="background: var(--chart-up)" />
            {{ t('overview.upload') }}
            <b class="mono">{{ formatSpeed(store.traffic.up) }}</b>
          </span>
          <span class="badge badge-success">
            <span class="dot dot-success" style="width: 6px; height: 6px; box-shadow: none" />
            {{ t('common.live') }}
          </span>
        </div>
      </template>
      <TrafficChart :down="store.traffic.historyDown" :up="store.traffic.historyUp" />
      <div class="traffic-totals">
        <span class="total-item">
          {{ t('overview.totalDown') }}
          <b class="mono">{{ formatBytes(store.connectionsDownloadTotal) }}</b>
        </span>
        <span class="total-item">
          {{ t('overview.totalUp') }}
          <b class="mono">{{ formatBytes(store.connectionsUploadTotal) }}</b>
        </span>
        <span class="total-item">
          {{ t('connections.active') }}
          <b class="mono">{{ store.connections.length }}</b>
        </span>
      </div>
    </UiCard>

    <div class="grid-2 mt-4">
      <!-- Outbound mode -->
      <UiCard :title="t('overview.modeTitle')" :desc="t('overview.modeDesc')">
        <div class="segmented mode-seg">
          <button
            v-for="m in modes"
            :key="m.id"
            class="segmented-item"
            :class="{ active: store.mode === m.id }"
            @click="switchMode(m.id)"
          >
            {{ m.label }}
          </button>
        </div>
        <p class="seg-desc">{{ activeModeDesc }}</p>
      </UiCard>

      <!-- System proxy -->
      <UiCard :title="t('overview.sysProxyTitle')">
        <template #actions>
          <UiSwitch
            :model-value="isSysProxyOn"
            :disabled="!isCoreRunning || togglingProxy"
            @update:model-value="toggleSystemProxy"
          />
        </template>
        <p class="sysproxy-desc">
          {{
            isSysProxyOn
              ? t('overview.sysProxyOnDesc', { port: store.status?.settings.mixedPort ?? 17890 })
              : t('overview.sysProxyOffDesc')
          }}
        </p>
      </UiCard>
    </div>

    <div class="grid-2 mt-4">
      <!-- Primary outbound -->
      <UiCard :title="t('overview.primaryTitle')">
        <template #actions>
          <button class="btn btn-ghost btn-sm" @click="navigate('proxies')">
            {{ t('overview.manage') }}
            <Icon name="chevron-right" :size="12" />
          </button>
        </template>
        <div class="primary-box">
          <div class="primary-group">{{ primaryGroup }}</div>
          <div class="primary-node-row">
            <span class="primary-node" :title="activeNodeName">{{ activeNodeName }}</span>
            <span v-if="activeDelay !== undefined" class="badge" :class="delayBadge(activeDelay)">
              {{ activeDelay > 0 ? `${activeDelay} ms` : t('common.timeout') }}
            </span>
          </div>
        </div>
      </UiCard>

      <!-- Core info -->
      <UiCard :title="t('overview.coreTitle')">
        <template #actions>
          <span class="badge" :class="isCoreRunning ? 'badge-success' : 'badge-danger'">
            {{ isCoreRunning ? t('common.running') : t('common.stopped') }}
          </span>
        </template>
        <dl class="info-list">
          <div class="info-item">
            <dt>{{ t('overview.version') }}</dt>
            <dd class="mono">{{ coreVersion || '-' }}</dd>
          </div>
          <div class="info-item">
            <dt>{{ t('overview.uptime') }}</dt>
            <dd class="mono">{{ uptime }}</dd>
          </div>
          <div class="info-item">
            <dt>{{ t('overview.mixedPort') }}</dt>
            <dd class="mono">127.0.0.1:{{ store.status?.settings.mixedPort ?? 17890 }}</dd>
          </div>
          <div class="info-item">
            <dt>{{ t('overview.controller') }}</dt>
            <dd class="mono">{{ store.status?.settings.controller || '-' }}</dd>
          </div>
        </dl>
      </UiCard>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { api } from "../api/index.js";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import TrafficChart from "../components/TrafficChart.vue";
import UiCard from "../components/UiCard.vue";
import UiSwitch from "../components/UiSwitch.vue";
import { locale, t } from "../i18n/index.js";
import { navigate } from "../router.js";
import { errorText, isCoreRunning, isSysProxyOn, proxyDelay, store, toast } from "../stores/index.js";
import type { OutboundMode } from "../types/index.js";
import { delayLevel, formatBytes, formatDuration, formatSpeed } from "../utils/format.js";

const togglingProxy = ref(false);

const modes = computed(() => [
  { id: "rule" as OutboundMode, label: t("overview.modeRule"), desc: t("overview.modeRuleDesc") },
  {
    id: "global" as OutboundMode,
    label: t("overview.modeGlobal"),
    desc: t("overview.modeGlobalDesc"),
  },
  {
    id: "direct" as OutboundMode,
    label: t("overview.modeDirect"),
    desc: t("overview.modeDirectDesc"),
  },
]);

const activeModeDesc = computed(
  () => modes.value.find((m) => m.id === store.mode)?.desc ?? "",
);

const primaryGroup = computed(
  () =>
    store.proxyGroups.find((g) => g.toUpperCase() === "PROXY" || g.toUpperCase() === "GLOBAL") ??
    store.proxyGroups[0] ??
    "",
);

const activeNodeName = computed(() => {
  const g = primaryGroup.value ? store.proxies[primaryGroup.value] : undefined;
  return g?.now ?? t("overview.noNode");
});

const activeDelay = computed(() => proxyDelay(activeNodeName.value));

const coreVersion = computed(() => {
  const v = store.status?.core.version ?? store.status?.settings.coreVersion;
  return v ? (v.startsWith("v") ? v : `v${v}`) : "";
});

const uptime = computed(() => formatDuration(store.status?.core.startedAt, locale.value));

function delayBadge(delay: number): string {
  const lvl = delayLevel(delay);
  return lvl === "good" ? "badge-success" : lvl === "mid" ? "badge-warning" : "badge-danger";
}

async function switchMode(mode: OutboundMode): Promise<void> {
  if (mode === store.mode) return;
  try {
    await api.setMode(mode);
    store.mode = mode;
    toast.success(t("toast.modeOk", { mode: t(`overview.mode${mode[0]?.toUpperCase()}${mode.slice(1)}`) }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

async function toggleSystemProxy(): Promise<void> {
  if (togglingProxy.value) return;
  togglingProxy.value = true;
  try {
    if (isSysProxyOn.value) {
      await api.disableSystemProxy();
      toast.success(t("toast.sysProxyOff"));
    } else {
      await api.enableSystemProxy();
      toast.success(t("toast.sysProxyOn"));
    }
    store.status = await api.getStatus();
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    togglingProxy.value = false;
  }
}
</script>

<style scoped>
.grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.traffic-now {
  display: flex;
  align-items: center;
  gap: 16px;
}
.now-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.now-item b {
  color: var(--text-primary);
  font-size: 13px;
}
.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  display: inline-block;
}
.traffic-totals {
  display: flex;
  gap: 24px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.total-item {
  font-size: 12px;
  color: var(--text-muted);
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.total-item b {
  color: var(--text-primary);
  font-size: 12.5px;
}

.mode-seg {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
}
.seg-desc {
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--text-muted);
}

.sysproxy-desc {
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.primary-box {
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 12px 14px;
}
.primary-group {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.primary-node-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 6px;
}
.primary-node {
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.info-list {
  display: flex;
  flex-direction: column;
}
.info-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--border);
}
.info-item:last-child {
  border-bottom: none;
}
.info-item dt {
  font-size: 12.5px;
  color: var(--text-muted);
}
.info-item dd {
  font-size: 12.5px;
  font-weight: 500;
}

@media (max-width: 760px) {
  .grid-2 {
    grid-template-columns: 1fr;
  }
}
</style>
