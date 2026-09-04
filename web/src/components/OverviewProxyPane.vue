<template>
  <section class="proxy-pane" :aria-label="t('overview.modeTitle')">
    <header class="proxy-pane-head">
      <div>
        <div class="proxy-title-row">
          <h2>{{ activeModeLabel }}</h2>
        </div>
        <p>{{ activeModeDescription }}</p>
      </div>
      <div
        v-if="store.mode !== 'direct' && store.proxyGroups.length > 0"
        class="search-box proxy-filter"
      >
        <Icon name="search" :size="13" />
        <input
          v-model="filterQuery"
          type="search"
          :aria-label="t('proxies.filter')"
          :placeholder="t('proxies.filter')"
        />
      </div>
      <span v-if="store.mode === 'rule'" class="group-count">
        {{ store.proxyGroups.length }} {{ t('profiles.statGroups') }}
      </span>
    </header>

    <div v-if="!isCoreRunning" class="empty-panel">
      <EmptyState icon="globe" :title="t('proxies.noGroups')" :hint="t('proxies.noGroupsHint')" />
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
          :collapsed="collapsedGroups.has(group)"
          :hide-timeout="hideTimeoutGroups.has(group)"
          @select="(name) => selectNode(group, name)"
          @test-group="testGroup(group)"
          @test-node="testSingle"
          @toggle-collapse="toggleCollapse(group)"
          @toggle-hide-timeout="toggleHideTimeout(group)"
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
          :collapsed="collapsedGroups.has(group)"
          :hide-timeout="hideTimeoutGroups.has(group)"
          @test-group="testGroup(group)"
          @test-node="testSingle"
          @toggle-collapse="toggleCollapse(group)"
          @toggle-hide-timeout="toggleHideTimeout(group)"
        />
      </template>

      <div v-if="selectorGroups.length === 0 && autoGroups.length === 0" class="empty-panel">
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
        :collapsed="collapsedGroups.has('GLOBAL')"
        :hide-timeout="hideTimeoutGroups.has('GLOBAL')"
        @select="(name) => selectNode('GLOBAL', name)"
        @test-group="testGroup('GLOBAL')"
        @test-node="testSingle"
        @toggle-collapse="toggleCollapse('GLOBAL')"
        @toggle-hide-timeout="toggleHideTimeout('GLOBAL')"
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
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useProxyLatency } from "../composables/proxy-latency.js";
import { t } from "../i18n/index.js";
import {
  errorText,
  isCoreRunning,
  selectGroupProxy,
  store,
  toast,
} from "../stores/index.js";
import EmptyState from "./EmptyState.vue";
import Icon from "./Icon.vue";
import ProxyGroupSection from "./ProxyGroupSection.vue";

const { testingGroups, testingNodes, testGroup, testSingle } = useProxyLatency();
const filterQuery = ref("");
const normalizedFilter = computed(() => filterQuery.value.trim().toLowerCase());
const collapsedGroups = ref(new Set<string>());
const hideTimeoutGroups = ref(new Set<string>());

function toggleCollapse(group: string): void {
  const next = new Set(collapsedGroups.value);
  if (next.has(group)) next.delete(group);
  else next.add(group);
  collapsedGroups.value = next;
}

function toggleHideTimeout(group: string): void {
  const next = new Set(hideTimeoutGroups.value);
  if (next.has(group)) next.delete(group);
  else next.add(group);
  hideTimeoutGroups.value = next;
}
const activeModeLabel = computed(() => {
  if (store.mode === "global") return t("overview.modeGlobal");
  if (store.mode === "direct") return t("overview.modeDirect");
  return t("overview.modeRule");
});
const activeModeDescription = computed(() => {
  if (store.mode === "global") return t("overview.modeGlobalDesc");
  if (store.mode === "direct") return t("overview.modeDirectDesc");
  return t("overview.modeRuleDesc");
});
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
const globalMembers = computed(() => filterMembers(store.proxies.GLOBAL?.all ?? []));

function filterMembers(members: string[]): string[] {
  if (!normalizedFilter.value) return members;
  return members.filter((name) => name.toLowerCase().includes(normalizedFilter.value));
}

// One pass over all groups so every ProxyGroupSection gets a stable array
// reference; per-render membersOf() calls would defeat prop memoization.
const membersByGroup = computed(() => {
  const map = new Map<string, string[]>();
  for (const group of store.proxyGroups) {
    map.set(group, filterMembers(store.proxies[group]?.all ?? []));
  }
  return map;
});

function membersOf(group: string): string[] {
  return membersByGroup.value.get(group) ?? [];
}

function nowOf(name: string): string {
  return store.proxies[name]?.now ?? "";
}

async function selectNode(group: string, name: string): Promise<void> {
  if (nowOf(group) === name) return;
  try {
    await selectGroupProxy(group, name);
    toast.success(t("toast.nodeOk", { name }));
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}
</script>

<style scoped>
.proxy-pane {
  min-width: 0;
  padding-bottom: 20px;
}
.proxy-pane-head {
  display: flex;
  min-height: 62px;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 10px;
  padding: 6px 2px 9px;
  border-bottom: 1px solid var(--border);
}
.proxy-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.proxy-pane-head h2 {
  color: var(--text-primary);
  font-size: 20px;
  font-weight: 500;
}
.proxy-pane-head p {
  margin-top: 5px;
  color: var(--text-muted);
  font-size: 14px;
}
.group-count {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 14px;
}
.proxy-filter {
  min-width: 140px;
  max-width: 240px;
  min-height: 30px;
  flex: 1;
}
.proxy-kind-heading {
  margin: 15px 0 7px;
  color: var(--text-muted);
  font-size: 12px;
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
  font-size: 16px;
  font-weight: 500;
}
.direct-copy span {
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 14px;
}
.direct-current {
  color: var(--selection);
  font-size: 14px;
  font-weight: 600;
}
.direct-hint {
  margin-top: 10px;
  color: var(--text-muted);
  font-size: 14px;
}

@media (max-width: 580px) {
  .proxy-pane-head {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
  .proxy-filter {
    width: 100%;
    max-width: none;
  }
  .group-count {
    align-self: flex-end;
  }
}
</style>
