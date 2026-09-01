<template>
  <div>
    <PageHeader :title="t('page.overview.title')" :desc="t('page.overview.desc')">
      <button class="btn btn-secondary btn-sm" :disabled="restarting" @click="restartCore">
        <Icon name="refresh" :size="13" :class="{ spin: restarting }" />
        <span>{{ t('settings.restartBtn') }}</span>
      </button>
    </PageHeader>

    <div class="ov-layout">
      <!-- ============ left: status & quick settings ============ -->
      <aside class="ov-side">
        <!-- Core -->
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
            <div class="info-item" v-if="store.status?.core.pid">
              <dt>{{ t('overview.pid') }}</dt>
              <dd class="mono">{{ store.status.core.pid }}</dd>
            </div>
          </dl>
        </UiCard>

        <!-- Quick settings -->
        <UiCard :title="t('overview.quickTitle')">
          <div class="kv-row">
            <span class="kv-label">{{ t('overview.sysProxyTitle') }}</span>
            <UiSwitch
              :model-value="isSysProxyOn"
              :disabled="!canToggleSystemProxy"
              @update:model-value="toggleSystemProxy"
            />
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ t('overview.tun') }}</span>
            <UiSwitch
              :model-value="store.status?.settings.tun ?? false"
              :disabled="store.operations.networkSetting"
              @update:model-value="(v: boolean) => applyNetToggle('tun', v)"
            />
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ t('overview.lan') }}</span>
            <UiSwitch
              :model-value="store.status?.settings.allowLan ?? false"
              :disabled="store.operations.networkSetting"
              @update:model-value="(v: boolean) => applyNetToggle('allow-lan', v)"
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

        <!-- Active profile -->
        <UiCard :title="t('overview.subTitle')">
          <template #actions>
            <button
              v-if="activeProfile?.url"
              class="icon-btn"
              :class="{ spin: refreshingSub }"
              :title="t('profiles.update')"
              :disabled="refreshingSub"
              @click="refreshActiveProfile"
            >
              <Icon name="refresh" :size="13" />
            </button>
          </template>
          <template v-if="activeProfile">
            <div class="kv-row">
              <span class="kv-label sub-host" :title="activeProfile.url || activeProfile.name">{{ activeProfile.name }}</span>
              <span class="badge badge-accent">{{ t('common.nodesCount', { n: totalNodes }) }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">{{ t('profiles.statGroups') }}</span>
              <span class="kv-value">{{ store.proxyGroups.length }}</span>
            </div>
          </template>
          <template v-else>
            <p class="sub-empty">{{ t('overview.subEmpty') }}</p>
            <button class="btn btn-primary btn-sm btn-block" @click="navigate('profiles')">
              {{ t('overview.subSet') }}
            </button>
          </template>
        </UiCard>

        <!-- Live traffic -->
        <UiCard :title="t('overview.trafficTitle')">
          <template #actions>
            <span class="badge badge-success ov-live-badge">
              <span class="dot dot-success" />
              {{ t('common.live') }}
            </span>
          </template>
          <div class="speed-row">
            <div class="speed-box">
              <span class="speed-num" style="color: var(--chart-down)">
                {{ formatSpeed(store.traffic.down) }}
              </span>
              <span class="speed-label">{{ t('overview.download') }}</span>
            </div>
            <div class="speed-box">
              <span class="speed-num" style="color: var(--chart-up)">
                {{ formatSpeed(store.traffic.up) }}
              </span>
              <span class="speed-label">{{ t('overview.upload') }}</span>
            </div>
          </div>
          <TrafficChart :down="store.traffic.historyDown" :up="store.traffic.historyUp" :height="104" />
          <div class="traffic-total">
            {{ t('overview.totalDown') }} {{ formatBytes(store.connectionsDownloadTotal) }} ·
            {{ t('overview.totalUp') }} {{ formatBytes(store.connectionsUploadTotal) }}
          </div>
        </UiCard>
      </aside>

      <!-- ============ right: proxies, driven by mode ============ -->
      <section class="ov-main">
        <div class="ov-modebar">
          <span class="ov-modebar-label">{{ t('overview.modeTitle') }}</span>
          <div class="segmented">
            <button
              v-for="m in modes"
              :key="m.id"
              class="segmented-item"
              :class="{ active: store.mode === m.id }"
              :disabled="store.operations.mode || !isCoreReady"
              @click="switchMode(m.id)"
            >
              {{ m.label }}
            </button>
          </div>
        </div>

        <div v-if="!isCoreRunning" class="card">
          <EmptyState
            icon="globe"
            :title="t('proxies.noGroups')"
            :hint="t('proxies.noGroupsHint')"
          />
        </div>

        <!-- rule: selector groups on top, auto groups below -->
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
              :busy="Boolean(store.operations.proxySelections[group])"
              show-current-tag
              @test-group="testGroup(group)"
              @test-node="testSingle"
            />
          </template>

          <div v-if="selectorGroups.length === 0 && autoGroups.length === 0" class="card">
            <EmptyState
              icon="globe"
              :title="t('proxies.noGroups')"
              :hint="t('proxies.noGroupsHint')"
            />
          </div>
        </template>

        <!-- global: everything in GLOBAL -->
        <template v-else-if="store.mode === 'global'">
          <ProxyGroupSection
            v-if="globalMembers.length > 0"
            group="GLOBAL"
            :members="globalMembers"
            :selectable="true"
            :testing="testingGroups.has('GLOBAL')"
            :busy="Boolean(store.operations.proxySelections.GLOBAL)"
            @select="(name) => selectNode('GLOBAL', name)"
            @test-group="testGroup('GLOBAL')"
            @test-node="testSingle"
          />
        </template>

        <!-- direct: everything goes DIRECT -->
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

/* ---------- left column state ---------- */
const restarting = ref(false);
const refreshingSub = ref(false);

const coreVersion = computed(() => {
  const version = store.status?.core.version;
  return version ? (version.startsWith("v") ? version : `v${version}`) : "";
});

const uptime = computed(() => formatDuration(store.status?.core.startedAt, locale.value));

const activeProfile = computed(() => store.status?.activeProfile ?? null);

const totalNodes = computed(
  () => Object.values(store.proxies).filter((p) => !(Array.isArray(p.all) && p.all.length > 0)).length,
);

/* ---------- mode ---------- */
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

/* ---------- proxy groups ---------- */
const testingGroups = ref(new Set<string>());
const testingNodes = ref(new Set<string>());

const selectorGroups = computed(() =>
  store.proxyGroups.filter((g) => store.proxies[g]?.type === "Selector" && g !== "GLOBAL"),
);
const autoGroups = computed(() =>
  store.proxyGroups.filter((g) => store.proxies[g]?.type !== "Selector" && g !== "GLOBAL"),
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

/* ---------- left column actions ---------- */
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
  const p = activeProfile.value;
  if (!p?.url || refreshingSub.value) return;
  refreshingSub.value = true;
  try {
    await updateProfile(p.id);
    toast.success(t("toast.profileUpdated", { name: p.name }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    refreshingSub.value = false;
  }
}

</script>

<style scoped>
.ov-layout {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.ov-side {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.ov-main {
  min-width: 0;
}

/* left column */
.info-list {
  display: flex;
  flex-direction: column;
}
.info-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  font-size: 12.5px;
}
.info-item + .info-item {
  border-top: 1px dashed var(--border);
}
.info-item dt {
  color: var(--text-muted);
}
.info-item dd {
  margin: 0;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kv-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  font-size: 13px;
}
.kv-row + .kv-row {
  border-top: 1px dashed var(--border);
}
.kv-label {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kv-value {
  font-size: 12px;
  color: var(--text-primary);
}
.sub-host {
  font-weight: 600;
  color: var(--text-primary);
}
.sub-empty {
  margin: 0 0 10px;
  font-size: 12.5px;
  color: var(--text-muted);
}
.btn-block {
  width: 100%;
  justify-content: center;
}
.ov-live-badge .dot {
  width: 6px;
  height: 6px;
  box-shadow: none;
}
.speed-row {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}
.speed-box {
  flex: 1;
  background: var(--bg-inset);
  border-radius: var(--radius-md);
  padding: 8px 12px;
}
.speed-num {
  display: block;
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.speed-label {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 1px;
}
.traffic-total {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted);
  text-align: right;
}

/* right column: mode bar */
.ov-modebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}
.ov-modebar-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

/* group sections */
.subhead {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin: 16px 2px 8px;
}
.direct-section {
  max-width: 320px;
}
.direct-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: var(--bg-card);
  border: 1px solid var(--border-accent);
  box-shadow: inset 2px 0 0 var(--accent);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  font-size: 13px;
}
.direct-card span {
  color: var(--text-muted);
  font-size: 11px;
}
.direct-hint {
  margin: 10px 2px 0;
  font-size: 12.5px;
  color: var(--text-muted);
}
.spin {
  animation: rotate 0.9s linear infinite;
}

@media (max-width: 1100px) {
  .ov-layout {
    grid-template-columns: 1fr;
  }
}
</style>
