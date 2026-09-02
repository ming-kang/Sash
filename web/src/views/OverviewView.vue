<template>
  <div class="overview">
    <PageHeader :title="t('page.overview.title')" :desc="t('page.overview.desc')">
      <button
        type="button"
        class="btn btn-secondary btn-sm restart-btn"
        :disabled="restarting"
        @click="restartCore"
      >
        <Icon name="refresh" :size="13" :class="{ spin: restarting }" />
        <span>{{ t('settings.restartBtn') }}</span>
      </button>
    </PageHeader>

    <section class="stat-grid" :aria-label="t('page.overview.title')">
      <article class="card stat-card core-stat" :class="{ running: isCoreRunning }">
        <span class="stat-label">{{ t('overview.coreTitle') }}</span>
        <div class="stat-value stat-status">
          <span class="dot" :class="isCoreRunning ? 'dot-success' : 'dot-danger'" />
          {{ isCoreRunning ? t('common.running') : t('common.stopped') }}
        </div>
        <span class="stat-meta mono">{{ coreVersion || '-' }}</span>
      </article>
      <article class="card stat-card down-stat">
        <span class="stat-label">{{ t('overview.download') }}</span>
        <span class="stat-value mono">{{ formatSpeed(store.traffic.down) }}</span>
        <span class="stat-meta">{{ t('common.live') }}</span>
      </article>
      <article class="card stat-card up-stat">
        <span class="stat-label">{{ t('overview.upload') }}</span>
        <span class="stat-value mono">{{ formatSpeed(store.traffic.up) }}</span>
        <span class="stat-meta">{{ t('common.live') }}</span>
      </article>
      <article class="card stat-card connection-stat">
        <span class="stat-label">{{ t('connections.active') }}</span>
        <span class="stat-value mono">{{ store.connections.length }}</span>
        <span class="stat-meta">{{ t('overview.status') }}</span>
      </article>
    </section>

    <div class="ov-layout">
      <aside class="ov-side">
        <UiCard :title="t('overview.coreTitle')" class="side-card core-card">
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
            <div v-if="store.status?.core.pid" class="info-item">
              <dt>{{ t('overview.pid') }}</dt>
              <dd class="mono">{{ store.status.core.pid }}</dd>
            </div>
          </dl>
        </UiCard>

        <UiCard :title="t('overview.quickTitle')" class="side-card quick-card">
          <div class="kv-row">
            <span class="kv-label">{{ t('overview.sysProxyTitle') }}</span>
            <UiSwitch
              :model-value="isSysProxyOn"
              :label="t('overview.sysProxyTitle')"
              :disabled="!canToggleSystemProxy"
              @update:model-value="toggleSystemProxy"
            />
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ t('overview.tun') }}</span>
            <UiSwitch
              :model-value="store.status?.settings.tun ?? false"
              :label="t('overview.tun')"
              :disabled="store.operations.networkSetting"
              @update:model-value="(value: boolean) => applyNetToggle('tun', value)"
            />
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ t('overview.lan') }}</span>
            <UiSwitch
              :model-value="store.status?.settings.allowLan ?? false"
              :label="t('overview.lan')"
              :disabled="store.operations.networkSetting"
              @update:model-value="(value: boolean) => applyNetToggle('allow-lan', value)"
            />
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ t('overview.mixedPort') }}</span>
            <span class="mono kv-value">127.0.0.1:{{ store.status?.settings.mixedPort ?? 17890 }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ t('overview.controller') }}</span>
            <span class="mono kv-value">{{ store.status?.settings.controller || '-' }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ t('overview.daemonPort') }}</span>
            <span class="mono kv-value">{{ store.status?.settings.daemonPort ?? 19090 }}</span>
          </div>
        </UiCard>

        <UiCard :title="t('overview.subTitle')" class="side-card profile-card">
          <template #actions>
            <button
              v-if="activeProfile?.url"
              type="button"
              class="icon-btn profile-refresh"
              :class="{ spin: refreshingSub }"
              :title="t('profiles.update')"
              :aria-label="t('profiles.update')"
              :disabled="refreshingSub"
              @click="refreshActiveProfile"
            >
              <Icon name="refresh" :size="14" />
            </button>
          </template>
          <template v-if="activeProfile">
            <div class="kv-row">
              <span class="kv-label sub-host" :title="activeProfile.url || activeProfile.name">
                {{ activeProfile.name }}
              </span>
              <span class="badge badge-accent">{{ t('common.nodesCount', { n: totalNodes }) }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">{{ t('profiles.statGroups') }}</span>
              <span class="kv-value">{{ store.proxyGroups.length }}</span>
            </div>
          </template>
          <template v-else>
            <p class="sub-empty">{{ t('overview.subEmpty') }}</p>
            <button
              type="button"
              class="btn btn-primary btn-sm btn-block"
              @click="navigate('profiles')"
            >
              {{ t('overview.subSet') }}
            </button>
          </template>
        </UiCard>
      </aside>

      <section class="ov-main">
        <UiCard :title="t('overview.trafficTitle')" class="traffic-card">
          <template #actions>
            <span class="badge badge-success ov-live-badge">
              <span class="dot dot-success" />
              {{ t('common.live') }}
            </span>
          </template>
          <div class="traffic-summary">
            <div class="speed-box down-speed">
              <span class="speed-label">{{ t('overview.download') }}</span>
              <span class="speed-num mono">{{ formatSpeed(store.traffic.down) }}</span>
            </div>
            <div class="speed-box up-speed">
              <span class="speed-label">{{ t('overview.upload') }}</span>
              <span class="speed-num mono">{{ formatSpeed(store.traffic.up) }}</span>
            </div>
            <div class="traffic-total">
              <span>{{ t('overview.totalDown') }} <strong class="mono">{{ formatBytes(store.connectionsDownloadTotal) }}</strong></span>
              <span>{{ t('overview.totalUp') }} <strong class="mono">{{ formatBytes(store.connectionsUploadTotal) }}</strong></span>
            </div>
          </div>
          <TrafficChart
            :down="store.traffic.historyDown"
            :up="store.traffic.historyUp"
            :height="168"
            :label="t('overview.trafficTitle')"
          />
        </UiCard>

        <div class="ov-modebar">
          <div class="mode-heading">
            <span class="ov-modebar-label">{{ t('overview.modeTitle') }}</span>
            <span class="mode-desc">{{ t('overview.modeDesc') }}</span>
          </div>
          <div class="segmented" role="group" :aria-label="t('overview.modeTitle')">
            <button
              v-for="mode in modes"
              :key="mode.id"
              type="button"
              class="segmented-item"
              :class="{ active: store.mode === mode.id }"
              :aria-pressed="store.mode === mode.id"
              :disabled="store.operations.mode || !isCoreReady"
              @click="switchMode(mode.id)"
            >
              {{ mode.label }}
            </button>
          </div>
        </div>

        <div v-if="!isCoreRunning" class="card empty-card">
          <EmptyState
            icon="globe"
            :title="t('proxies.noGroups')"
            :hint="t('proxies.noGroupsHint')"
          />
        </div>

        <template v-else-if="store.mode === 'rule'">
          <template v-if="selectorGroups.length > 0">
            <div class="subhead">{{ t('proxies.manual') }}</div>
            <ProxyGroupSection
              v-for="group in selectorGroups"
              :key="group"
              :group="group"
              :members="membersOf(group)"
              :selectable="true"
              :testing="testingGroups.has(group)"
              :testing-nodes="testingNodes"
              :busy="Boolean(store.operations.proxySelections[group])"
              @select="(name) => selectNode(group, name)"
              @test-group="testGroup(group)"
              @test-node="testSingle"
            />
          </template>

          <template v-if="autoGroups.length > 0">
            <div class="subhead">{{ t('proxies.auto') }}</div>
            <ProxyGroupSection
              v-for="group in autoGroups"
              :key="group"
              :group="group"
              :members="membersOf(group)"
              :selectable="false"
              :testing="testingGroups.has(group)"
              :testing-nodes="testingNodes"
              :busy="Boolean(store.operations.proxySelections[group])"
              show-current-tag
              @test-group="testGroup(group)"
              @test-node="testSingle"
            />
          </template>

          <div v-if="selectorGroups.length === 0 && autoGroups.length === 0" class="card empty-card">
            <EmptyState
              icon="globe"
              :title="t('proxies.noGroups')"
              :hint="t('proxies.noGroupsHint')"
            />
          </div>
        </template>

        <template v-else-if="store.mode === 'global'">
          <ProxyGroupSection
            v-if="globalMembers.length > 0"
            group="GLOBAL"
            :members="globalMembers"
            :selectable="true"
            :testing="testingGroups.has('GLOBAL')"
            :testing-nodes="testingNodes"
            :busy="Boolean(store.operations.proxySelections.GLOBAL)"
            @select="(name) => selectNode('GLOBAL', name)"
            @test-group="testGroup('GLOBAL')"
            @test-node="testSingle"
          />
        </template>

        <template v-else>
          <section class="direct-section">
            <div class="direct-card">
              <strong>DIRECT</strong>
              <span>Direct</span>
            </div>
            <p class="direct-hint">{{ t('proxies.directHint') }}</p>
          </section>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { api } from "../api/index.js";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import ProxyGroupSection from "../components/ProxyGroupSection.vue";
import TrafficChart from "../components/TrafficChart.vue";
import UiCard from "../components/UiCard.vue";
import UiSwitch from "../components/UiSwitch.vue";
import { confirmDialog } from "../components/confirm.js";
import { locale, t } from "../i18n/index.js";
import { navigate } from "../router.js";
import {
  canToggleSystemProxy,
  errorText,
  isCoreReady,
  isCoreRunning,
  isSysProxyOn,
  patchBooleanSetting,
  refreshRuntimeState,
  selectGroupProxy,
  setOutboundMode,
  setSystemProxyEnabled,
  store,
  toast,
  updateProfile,
  updateProxyDelay,
} from "../stores/index.js";
import type { OutboundMode } from "../types/index.js";
import { formatBytes, formatDuration, formatSpeed } from "../utils/format.js";

const restarting = ref(false);
const refreshingSub = ref(false);

const coreVersion = computed(() => {
  const version = store.status?.core.version;
  return version ? (version.startsWith("v") ? version : `v${version}`) : "";
});

const uptime = computed(() => formatDuration(store.status?.core.startedAt, locale.value));
const activeProfile = computed(() => store.status?.activeProfile ?? null);
const totalNodes = computed(
  () => Object.values(store.proxies).filter((proxy) => !(Array.isArray(proxy.all) && proxy.all.length > 0)).length,
);

const modes = computed(() => [
  { id: "rule" as OutboundMode, label: t("overview.modeRule") },
  { id: "global" as OutboundMode, label: t("overview.modeGlobal") },
  { id: "direct" as OutboundMode, label: t("overview.modeDirect") },
]);

async function switchMode(mode: OutboundMode): Promise<void> {
  if (mode === store.mode) return;
  try {
    await setOutboundMode(mode);
    toast.success(t("toast.modeOk", { mode: t(`overview.mode${mode[0]?.toUpperCase()}${mode.slice(1)}`) }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

const testingGroups = ref(new Set<string>());
const testingNodes = ref(new Set<string>());

const selectorGroups = computed(() =>
  store.proxyGroups.filter((group) => store.proxies[group]?.type === "Selector" && group !== "GLOBAL"),
);
const autoGroups = computed(() =>
  store.proxyGroups.filter((group) => store.proxies[group]?.type !== "Selector" && group !== "GLOBAL"),
);
const globalMembers = computed(() => store.proxies.GLOBAL?.all ?? []);

function membersOf(group: string): string[] {
  return store.proxies[group]?.all ?? [];
}

function nowOf(name: string): string {
  return store.proxies[name]?.now ?? "";
}

async function selectNode(group: string, name: string): Promise<void> {
  if (nowOf(group) === name) return;
  try {
    await selectGroupProxy(group, name);
    toast.success(t("toast.nodeOk", { name }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

async function testGroup(group: string): Promise<void> {
  if (testingGroups.value.has(group)) return;
  testingGroups.value = new Set(testingGroups.value).add(group);
  const generation = store.runtimeGeneration;
  try {
    const delays = await api.testGroupDelay(group);
    for (const [name, delay] of Object.entries(delays)) updateProxyDelay(name, delay, generation);
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    const next = new Set(testingGroups.value);
    next.delete(group);
    testingGroups.value = next;
  }
}

async function testSingle(name: string): Promise<void> {
  if (testingNodes.value.has(name)) return;
  testingNodes.value = new Set(testingNodes.value).add(name);
  const generation = store.runtimeGeneration;
  try {
    updateProxyDelay(name, (await api.testProxyDelay(name)).delay, generation);
  } catch {
    updateProxyDelay(name, 0, generation);
  } finally {
    const next = new Set(testingNodes.value);
    next.delete(name);
    testingNodes.value = next;
  }
}

async function toggleSystemProxy(target: boolean): Promise<void> {
  try {
    await setSystemProxyEnabled(target);
    toast.success(t(target ? "toast.sysProxyOn" : "toast.sysProxyOff"));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

async function applyNetToggle(key: "allow-lan" | "tun", next: boolean): Promise<void> {
  try {
    await patchBooleanSetting(key, next);
    toast.success(t("toast.settingSaved"));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

async function restartCore(): Promise<void> {
  const ok = await confirmDialog({
    title: t("settings.restartConfirmTitle"),
    message: t("settings.restartConfirmMsg"),
    confirmText: t("common.confirm"),
    cancelText: t("common.cancel"),
    danger: true,
  });
  if (!ok) return;
  restarting.value = true;
  try {
    await api.restartCore();
    await refreshRuntimeState();
    toast.success(t("toast.coreRestarted"));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    restarting.value = false;
  }
}

async function refreshActiveProfile(): Promise<void> {
  const profile = activeProfile.value;
  if (!profile?.url || refreshingSub.value) return;
  refreshingSub.value = true;
  try {
    await updateProfile(profile.id);
    toast.success(t("toast.profileUpdated", { name: profile.name }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    refreshingSub.value = false;
  }
}
</script>

<style scoped>
.overview {
  min-width: 0;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.stat-card {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  min-width: 0;
  min-height: 94px;
  overflow: hidden;
  padding: 14px 16px;
}
.stat-card::after {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 3px;
  background: var(--border-strong);
  content: "";
}
.core-stat.running::after {
  background: var(--success);
}
.down-stat::after {
  background: var(--chart-down);
}
.up-stat::after {
  background: var(--chart-up);
}
.connection-stat::after {
  background: var(--accent);
}
.stat-label {
  grid-column: 1 / -1;
  align-self: start;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.stat-value {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: clamp(17px, 1.65vw, 23px);
  font-weight: 720;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stat-status {
  display: flex;
  align-items: center;
  gap: 8px;
}
.stat-meta {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 10.5px;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-layout {
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.ov-side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.ov-main {
  min-width: 0;
}
.side-card {
  min-width: 0;
}
.core-card {
  border-top: 2px solid var(--border-accent);
}
.quick-card {
  border-top: 2px solid var(--accent);
}
.profile-card {
  border-top: 2px solid var(--border-strong);
}
.info-list {
  display: flex;
  flex-direction: column;
}
.info-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 0;
  font-size: 12.5px;
}
.info-item + .info-item,
.kv-row + .kv-row {
  border-top: 1px dashed var(--border);
}
.info-item dt {
  color: var(--text-muted);
}
.info-item dd {
  min-width: 0;
  overflow: hidden;
  margin: 0;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kv-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  padding: 7px 0;
  font-size: 13px;
}
.kv-label {
  min-width: 0;
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kv-value {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub-host {
  color: var(--text-primary);
  font-weight: 650;
}
.sub-empty {
  margin: 0 0 10px;
  color: var(--text-muted);
  font-size: 12.5px;
}
.btn-block {
  width: 100%;
  justify-content: center;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  color: var(--text-secondary);
  cursor: pointer;
}
.icon-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-hover);
  color: var(--accent);
}
.icon-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.traffic-card {
  min-width: 0;
  overflow: hidden;
  border-color: var(--border-accent);
  box-shadow: var(--shadow-card), 0 0 0 1px var(--accent-ring);
}
.ov-live-badge .dot {
  width: 6px;
  height: 6px;
  box-shadow: none;
}
.traffic-summary {
  display: grid;
  grid-template-columns: minmax(120px, auto) minmax(120px, auto) minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.speed-box {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}
.speed-num {
  overflow: hidden;
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.down-speed .speed-num {
  color: var(--chart-down);
}
.up-speed .speed-num {
  color: var(--chart-up);
}
.speed-label {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 10.5px;
}
.traffic-total {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 3px 12px;
  color: var(--text-muted);
  font-size: 10.5px;
  text-align: right;
}
.traffic-total strong {
  color: var(--text-secondary);
  font-weight: 600;
}
.ov-modebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-width: 0;
  margin: 16px 0 10px;
  padding: 9px 10px 9px 13px;
  border: 1px solid var(--border-accent);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-md);
  background: var(--accent-soft);
}
.mode-heading {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ov-modebar-label {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 700;
}
.mode-desc {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.segmented {
  flex-shrink: 0;
  background: var(--bg-card);
}
.subhead {
  margin: 17px 2px 8px;
  color: var(--text-muted);
  font-size: 10.5px;
  font-weight: 750;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
.empty-card {
  overflow: hidden;
}
.direct-section {
  max-width: 360px;
}
.direct-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 13px 15px;
  border: 1px solid var(--border-accent);
  border-radius: var(--radius-md);
  background: var(--bg-card);
  box-shadow: inset 3px 0 0 var(--accent);
  font-size: 13px;
}
.direct-card span {
  color: var(--text-muted);
  font-size: 11px;
}
.direct-hint {
  margin: 10px 2px 0;
  color: var(--text-muted);
  font-size: 12.5px;
}
.spin {
  animation: rotate 0.9s linear infinite;
}

@media (max-width: 1200px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .ov-layout {
    grid-template-columns: 300px minmax(0, 1fr);
  }
  .traffic-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .traffic-total {
    grid-column: 1 / -1;
    justify-content: flex-start;
    text-align: left;
  }
}

@media (max-width: 760px) {
  .ov-layout {
    grid-template-columns: 1fr;
  }
  .ov-side {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .quick-card {
    grid-row: span 2;
  }
  .restart-btn,
  .btn-block,
  .segmented-item,
  .icon-btn {
    min-height: 40px;
  }
  .icon-btn {
    min-width: 40px;
  }
  .quick-card :deep(.switch) {
    width: 44px;
    min-height: 40px;
  }
  .quick-card :deep(.knob) {
    top: 10px;
  }
  .quick-card :deep(.switch.on .knob) {
    transform: translateX(20px);
  }
  .ov-modebar {
    align-items: flex-start;
    flex-direction: column;
  }
  .segmented {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    width: 100%;
  }
  .segmented-item {
    padding-right: 8px;
    padding-left: 8px;
  }
}

@media (max-width: 480px) {
  .stat-grid {
    gap: 8px;
  }
  .stat-card {
    min-height: 86px;
    padding: 11px 12px;
  }
  .stat-value {
    font-size: 16px;
  }
  .stat-meta {
    display: none;
  }
  .ov-side {
    display: flex;
  }
  .traffic-summary {
    grid-template-columns: 1fr;
  }
  .traffic-total {
    grid-column: auto;
  }
  .speed-box {
    justify-content: space-between;
  }
  .traffic-card {
    margin-right: 0;
    margin-left: 0;
  }
  .mode-desc {
    white-space: normal;
  }
  .kv-value {
    max-width: 58%;
  }
}
</style>
