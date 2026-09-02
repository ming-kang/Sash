<template>
  <div class="overview">
    <PageHeader :title="t('page.overview.title')" :desc="t('page.overview.desc')">
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="restarting"
        @click="restartCore"
      >
        <Icon name="refresh" :size="13" :class="{ spin: restarting }" />
        <span>{{ t('settings.restartBtn') }}</span>
      </button>
    </PageHeader>

    <div class="overview-split">
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
                :disabled="store.operations.networkSetting"
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
                :disabled="store.operations.networkSetting"
                @update:model-value="(value: boolean) => applyNetToggle('tun', value)"
              />
            </div>
          </div>

          <div class="general-row">
            <div class="general-label">{{ t('overview.mixedPort') }}</div>
            <div class="general-value mono">127.0.0.1:{{ store.status?.settings.mixedPort ?? 17890 }}</div>
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
            <span>{{ t('overview.totalDown') }} <strong class="mono">{{ formatBytes(store.connectionsDownloadTotal) }}</strong></span>
            <span>{{ t('overview.totalUp') }} <strong class="mono">{{ formatBytes(store.connectionsUploadTotal) }}</strong></span>
          </div>
        </section>
      </aside>

      <section class="proxy-pane" :aria-label="t('overview.modeTitle')">
        <header class="proxy-pane-head">
          <div>
            <div class="proxy-title-row">
              <span class="proxy-mode-code">{{ store.mode.toUpperCase() }}</span>
              <h2>{{ activeModeLabel }}</h2>
            </div>
            <p>{{ activeModeDescription }}</p>
          </div>
          <span v-if="store.mode === 'rule'" class="group-count">
            {{ store.proxyGroups.length }} {{ t('profiles.statGroups') }}
          </span>
        </header>

        <div v-if="!isCoreRunning" class="empty-panel">
          <EmptyState
            icon="globe"
            :title="t('proxies.noGroups')"
            :hint="t('proxies.noGroupsHint')"
          />
        </div>

        <template v-else-if="store.mode === 'rule'">
          <template v-if="selectorGroups.length > 0">
            <div class="proxy-kind-heading">{{ t('proxies.manual') }}</div>
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
            <div class="proxy-kind-heading">{{ t('proxies.auto') }}</div>
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

          <div
            v-if="selectorGroups.length === 0 && autoGroups.length === 0"
            class="empty-panel"
          >
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
          <div v-else class="empty-panel">
            <EmptyState
              icon="globe"
              :title="t('proxies.noGroups')"
              :hint="t('proxies.noGroupsHint')"
            />
          </div>
        </template>

        <template v-else>
          <article class="direct-node" aria-current="true">
            <span class="direct-indicator" />
            <div class="direct-copy">
              <strong>DIRECT</strong>
              <span>Direct</span>
            </div>
            <span class="direct-current">{{ t('proxies.currentTag') }}</span>
          </article>
          <p class="direct-hint">{{ t('proxies.directHint') }}</p>
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
  tunRuntime,
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
  () =>
    Object.values(store.proxies).filter(
      (proxy) => !(Array.isArray(proxy.all) && proxy.all.length > 0),
    ).length,
);
const tunStatusBadge = computed(() => {
  switch (tunRuntime.value) {
    case "active":
      return {
        text: t("settings.tunStateActive"),
        title: t("settings.tunDesc"),
        className: "badge-success",
      };
    case "inactive":
      return {
        text: t("settings.tunStateInactive"),
        title: t("settings.tunInactiveDesc"),
        className: "badge-warning",
      };
    case "unverified":
      return {
        text: t("settings.tunStateUnverified"),
        title: t("settings.tunUnverifiedDesc"),
        className: "badge-warning",
      };
    case "stopped":
      return {
        text: t("settings.tunStateStopped"),
        title: t("settings.tunDesc"),
        className: "badge-neutral",
      };
    case "unexpected-active":
      return {
        text: t("settings.tunStateUnexpected"),
        title: t("settings.tunUnexpectedDesc"),
        className: "badge-warning",
      };
    default:
      return null;
  }
});

const modes = computed(() => [
  { id: "global" as OutboundMode, label: t("overview.modeGlobal") },
  { id: "rule" as OutboundMode, label: t("overview.modeRule") },
  { id: "direct" as OutboundMode, label: t("overview.modeDirect") },
]);
const activeModeLabel = computed(
  () => modes.value.find((mode) => mode.id === store.mode)?.label ?? store.mode.toUpperCase(),
);
const activeModeDescription = computed(() => {
  if (store.mode === "global") return t("overview.modeGlobalDesc");
  if (store.mode === "direct") return t("overview.modeDirectDesc");
  return t("overview.modeRuleDesc");
});

async function switchMode(mode: OutboundMode): Promise<void> {
  if (mode === store.mode) return;
  try {
    await setOutboundMode(mode);
    toast.success(
      t("toast.modeOk", {
        mode: t(`overview.mode${mode[0]?.toUpperCase()}${mode.slice(1)}`),
      }),
    );
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

const testingGroups = ref(new Set<string>());
const testingNodes = ref(new Set<string>());

const selectorGroups = computed(() =>
  store.proxyGroups.filter(
    (group) => store.proxies[group]?.type === "Selector" && group !== "GLOBAL",
  ),
);
const autoGroups = computed(() =>
  store.proxyGroups.filter(
    (group) => store.proxies[group]?.type !== "Selector" && group !== "GLOBAL",
  ),
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
  --general-title: #2c3e50;
  min-width: 0;
}
:global(html[data-theme="dark"]) .overview {
  --general-title: #e5e2e8;
}

.overview-split {
  display: grid;
  grid-template-columns: minmax(300px, 1fr) minmax(0, 2fr);
  align-items: start;
  gap: clamp(18px, 2.2vw, 32px);
}
.general-pane,
.proxy-pane {
  min-width: 0;
}
.general-pane {
  overflow: hidden;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
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

.proxy-pane {
  padding-bottom: 24px;
}
.proxy-pane-head {
  display: flex;
  min-height: 70px;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 15px;
  padding: 8px 2px 12px;
  border-bottom: 1px solid var(--border);
}
.proxy-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.proxy-mode-code {
  display: inline-flex;
  min-width: 48px;
  min-height: 25px;
  align-items: center;
  justify-content: center;
  padding: 3px 7px;
  border-radius: var(--radius-xs);
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.05em;
}
.proxy-pane-head h2 {
  color: var(--text-primary);
  font-size: 20px;
  font-weight: 500;
}
.proxy-pane-head p {
  margin-top: 5px;
  color: var(--text-muted);
  font-size: 11.5px;
}
.group-count {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 10.5px;
}
.proxy-kind-heading {
  margin: 21px 0 9px;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.empty-panel {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.direct-node {
  position: relative;
  display: flex;
  min-height: 82px;
  align-items: center;
  gap: 13px;
  padding: 13px 15px 13px 20px;
  overflow: hidden;
  background: var(--selection-soft);
  border: 1px solid var(--selection-border);
  border-radius: var(--radius-sm);
}
.direct-indicator {
  position: absolute;
  top: 5px;
  bottom: 5px;
  left: 0;
  width: 5px;
  border-radius: 0 var(--radius-full) var(--radius-full) 0;
  background: var(--selection);
}
.direct-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}
.direct-copy strong {
  color: var(--text-primary);
  font-size: 14.5px;
  font-weight: 500;
}
.direct-copy span {
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 11px;
}
.direct-current {
  color: var(--selection);
  font-size: 10.5px;
  font-weight: 600;
}
.direct-hint {
  margin-top: 10px;
  color: var(--text-muted);
  font-size: 11.5px;
}

@media (max-width: 1120px) {
  .overview-split {
    grid-template-columns: minmax(280px, 0.9fr) minmax(0, 1.7fr);
    gap: 18px;
  }
}

@media (max-width: 820px) {
  .overview-split {
    grid-template-columns: 1fr;
  }
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
  .proxy-pane-head {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
  .group-count {
    align-self: flex-end;
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
