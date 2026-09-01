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
              :disabled="!isCoreRunning || togglingProxy"
              @update:model-value="toggleSystemProxy"
            />
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ t('overview.tun') }}</span>
            <UiSwitch
              :model-value="store.status?.settings.tun ?? false"
              :disabled="togglingNet"
              @update:model-value="(v: boolean) => applyNetToggle('tun', v)"
            />
          </div>
          <div class="kv-row">
            <span class="kv-label">{{ t('overview.lan') }}</span>
            <UiSwitch
              :model-value="store.status?.settings.allowLan ?? false"
              :disabled="togglingNet"
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
            <section v-for="g in selectorGroups" :key="g" class="pgroup">
              <div class="pgroup-head">
                <span class="pgroup-name">{{ g }}</span>
                <span class="pgroup-type">{{ typeBadge(g) }}</span>
                <span class="pgroup-now" :title="nowOf(g)">{{ nowOf(g) }}</span>
                <span class="pgroup-spacer"></span>
                <button
                  class="icon-btn"
                  :class="{ spin: testingGroup === g }"
                  :title="t('proxies.testAll')"
                  :disabled="testingGroup === g"
                  @click="testGroup(g)"
                >
                  <Icon name="zap" :size="13" />
                </button>
              </div>
              <div class="pgroup-grid">
                <button
                  v-for="m in membersOf(g)"
                  :key="m"
                  class="node-card"
                  :class="{ selected: nowOf(g) === m }"
                  @click="selectNode(g, m)"
                >
                  <div class="node-top">
                    <span class="node-name" :title="m">{{ m }}</span>
                    <span class="node-delay" :class="delayClass(m)" @click.stop="testSingle(m)">
                      {{ delayText(m) }}
                    </span>
                  </div>
                  <div class="node-sub">
                    {{ typeOf(m) }}<template v-if="isGroup(m) && nowOf(m)"> · {{ nowOf(m) }}</template>
                    <span v-if="hasUdp(m)" class="udp-tag">UDP</span>
                  </div>
                </button>
              </div>
            </section>
          </template>

          <template v-if="autoGroups.length > 0">
            <div class="subhead">{{ t('proxies.auto') }}</div>
            <section v-for="g in autoGroups" :key="g" class="pgroup">
              <div class="pgroup-head">
                <span class="pgroup-name">{{ g }}</span>
                <span class="pgroup-type">{{ typeBadge(g) }}</span>
                <span class="pgroup-now" :title="nowOf(g)">{{ nowOf(g) }}</span>
                <span class="pgroup-spacer"></span>
                <button
                  class="icon-btn"
                  :class="{ spin: testingGroup === g }"
                  :title="t('proxies.testAll')"
                  :disabled="testingGroup === g"
                  @click="testGroup(g)"
                >
                  <Icon name="zap" :size="13" />
                </button>
              </div>
              <div class="pgroup-grid">
                <div v-for="m in membersOf(g)" :key="m" class="node-card static">
                  <div class="node-top">
                    <span class="node-name" :title="m">{{ m }}</span>
                    <span class="node-delay" :class="delayClass(m)" @click.stop="testSingle(m)">
                      {{ delayText(m) }}
                    </span>
                  </div>
                  <div class="node-sub">
                    {{ typeOf(m) }}<template v-if="isGroup(m) && nowOf(m)"> · {{ nowOf(m) }}</template>
                    <span v-if="hasUdp(m)" class="udp-tag">UDP</span>
                    <span v-if="nowOf(g) === m" class="node-current">{{ t('proxies.currentTag') }}</span>
                  </div>
                </div>
              </div>
            </section>
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
          <section v-if="globalMembers.length > 0" class="pgroup">
            <div class="pgroup-head">
              <span class="pgroup-name">GLOBAL</span>
              <span class="pgroup-type">S</span>
              <span class="pgroup-now" :title="nowOf('GLOBAL')">{{ nowOf('GLOBAL') }}</span>
              <span class="pgroup-spacer"></span>
              <button
                class="icon-btn"
                :class="{ spin: testingGroup === 'GLOBAL' }"
                :title="t('proxies.testAll')"
                :disabled="testingGroup === 'GLOBAL'"
                @click="testGroup('GLOBAL')"
              >
                <Icon name="zap" :size="13" />
              </button>
            </div>
            <div class="pgroup-grid">
              <button
                v-for="m in globalMembers"
                :key="m"
                class="node-card"
                :class="{ selected: nowOf('GLOBAL') === m }"
                @click="selectNode('GLOBAL', m)"
              >
                <div class="node-top">
                  <span class="node-name" :title="m">{{ m }}</span>
                  <span class="node-delay" :class="delayClass(m)" @click.stop="testSingle(m)">
                    {{ delayText(m) }}
                  </span>
                </div>
                <div class="node-sub">
                  {{ typeOf(m) }}<template v-if="isGroup(m) && nowOf(m)"> · {{ nowOf(m) }}</template>
                  <span v-if="hasUdp(m)" class="udp-tag">UDP</span>
                </div>
              </button>
            </div>
          </section>
        </template>

        <!-- direct: everything goes DIRECT -->
        <template v-else>
          <section class="pgroup">
            <div class="pgroup-grid pgroup-grid-single">
              <div class="node-card static selected">
                <div class="node-top">
                  <span class="node-name">DIRECT</span>
                </div>
                <div class="node-sub">Direct</div>
              </div>
            </div>
            <p class="direct-hint">{{ t('proxies.directHint') }}</p>
          </section>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api } from "../api/index.js";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import TrafficChart from "../components/TrafficChart.vue";
import UiCard from "../components/UiCard.vue";
import UiSwitch from "../components/UiSwitch.vue";
import { confirmDialog } from "../components/confirm.js";
import { locale, t } from "../i18n/index.js";
import { navigate } from "../router.js";
import {
  errorText,
  isCoreRunning,
  isSysProxyOn,
  proxyDelay,
  setProxies,
  store,
  toast,
  updateProxyDelay,
} from "../stores/index.js";
import type { OutboundMode } from "../types/index.js";
import { delayLevel, formatBytes, formatDuration, formatSpeed } from "../utils/format.js";

/* ---------- left column state ---------- */
const togglingProxy = ref(false);
const togglingNet = ref(false);
const restarting = ref(false);
const refreshingSub = ref(false);

const coreVersion = computed(() => {
  const v = store.status?.core.version ?? store.status?.settings.coreVersion;
  return v ? (v.startsWith("v") ? v : `v${v}`) : "";
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
    await api.setMode(mode);
    store.mode = mode;
    toast.success(t("toast.modeOk", { mode: t(`overview.mode${mode[0]?.toUpperCase()}${mode.slice(1)}`) }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

/* ---------- proxy groups ---------- */
const testingGroup = ref("");
const testingSingle = ref("");

const GROUP_ORDER_TYPE = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Relay"]);

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

function typeOf(name: string): string {
  return store.proxies[name]?.type ?? "";
}

function typeBadge(group: string): string {
  return (store.proxies[group]?.type ?? "S").charAt(0);
}

function isGroup(name: string): boolean {
  return GROUP_ORDER_TYPE.has(typeOf(name));
}

function hasUdp(name: string): boolean {
  return store.proxies[name]?.udp ?? false;
}

function delayText(name: string): string {
  const d = proxyDelay(name);
  if (d === undefined) return t("common.untested");
  if (d <= 0) return t("common.timeout");
  return `${d} ms`;
}

function delayClass(name: string): string {
  const d = proxyDelay(name);
  if (d === undefined) return "delay-none";
  const lvl = delayLevel(d);
  return lvl === "good" ? "delay-good" : lvl === "mid" ? "delay-mid" : "delay-bad";
}

async function refreshProxies(): Promise<void> {
  try {
    const res = await api.getProxies();
    setProxies(res.proxies);
  } catch {
    // keep previous data; offline banner handles daemon loss
  }
}

async function selectNode(group: string, name: string): Promise<void> {
  if (nowOf(group) === name) return;
  try {
    await api.selectProxy(group, name);
    await refreshProxies();
    toast.success(t("toast.nodeOk", { name }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

async function testGroup(group: string): Promise<void> {
  if (testingGroup.value) return;
  testingGroup.value = group;
  try {
    const delays = await api.testGroupDelay(group);
    for (const [name, delay] of Object.entries(delays)) {
      updateProxyDelay(name, delay);
    }
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    testingGroup.value = "";
  }
}

async function testSingle(name: string): Promise<void> {
  if (testingSingle.value) return;
  testingSingle.value = name;
  try {
    const res = await api.testProxyDelay(name);
    updateProxyDelay(name, res.delay);
  } catch {
    updateProxyDelay(name, 0);
  } finally {
    testingSingle.value = "";
  }
}

/* ---------- left column actions ---------- */
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

async function applyNetToggle(key: "allow-lan" | "tun", next: boolean): Promise<void> {
  if (togglingNet.value) return;
  togglingNet.value = true;
  try {
    await api.patchSetting(key, next ? "on" : "off");
    store.status = await api.getStatus();
    toast.success(t("toast.settingSaved"));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    togglingNet.value = false;
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
    store.status = await api.getStatus();
    await refreshProxies();
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
    await api.updateProfile(p.id);
    store.status = await api.getStatus();
    await refreshProxies();
    toast.success(t("toast.profileUpdated", { name: p.name }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    refreshingSub.value = false;
  }
}

/* ---------- lifecycle ---------- */
let pollTimer: number | null = null;

onMounted(() => {
  void refreshProxies();
  // Keep group `now` and delays fresh while the page is open (urltest groups
  // re-select on their own).
  pollTimer = window.setInterval(() => {
    if (isCoreRunning.value) void refreshProxies();
  }, 5000);
});

onUnmounted(() => {
  if (pollTimer !== null) clearInterval(pollTimer);
});
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
.pgroup {
  margin-bottom: 14px;
}
.pgroup-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.pgroup-name {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text-primary);
}
.pgroup-type {
  font-size: 10px;
  font-weight: 700;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 4px;
  padding: 1px 5px;
  line-height: 1.5;
}
.pgroup-now {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pgroup-spacer {
  flex: 1;
}
.pgroup-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}
.pgroup-grid-single {
  max-width: 320px;
}

/* node cards */
.node-card {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease,
    transform 0.12s ease;
}
button.node-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-card);
}
.node-card.selected {
  border-color: var(--border-accent);
  box-shadow: inset 2px 0 0 var(--accent);
}
.node-card.static {
  cursor: default;
}
.node-card.static:hover {
  border-color: var(--border);
  box-shadow: none;
}
.node-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.node-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-delay {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
  cursor: pointer;
}
.node-delay:hover {
  text-decoration: underline dotted;
}
.delay-good {
  color: var(--success);
}
.delay-mid {
  color: var(--warning);
}
.delay-bad {
  color: var(--danger);
}
.delay-none {
  color: var(--text-muted);
}
.node-sub {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-current {
  color: var(--accent);
  font-weight: 600;
  margin-left: 4px;
}
.udp-tag {
  display: inline-block;
  font-size: 9.5px;
  font-weight: 600;
  color: var(--text-secondary);
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  padding: 0 4px;
  margin-left: 4px;
  line-height: 1.5;
  vertical-align: 1px;
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
