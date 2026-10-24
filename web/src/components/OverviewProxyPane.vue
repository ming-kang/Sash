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
    </header>

    <div v-if="!isCoreRunning" class="empty-panel">
      <EmptyState icon="globe" :title="t('proxies.coreStopped')" :hint="t('proxies.coreStoppedHint')" />
    </div>

    <div v-else-if="store.mode !== 'direct' && !store.resourceLoaded.proxies" class="empty-panel" aria-busy="true">
      <EmptyState icon="loader" :title="t('proxies.loading')" />
    </div>

    <template v-else-if="store.mode === 'rule'">
      <template v-if="selectorGroups.length > 0 && (!normalizedFilter || anyVisibleMembers)">
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
          :pending="pendingSelection?.group === group ? pendingSelection.name : ''"
          :collapsed="collapsedGroups.has(group)"
          :hide-timeout="hideTimeoutGroups.has(group)"
          @select="(name) => selectNode(group, name)"
          @test-group="testGroup(group)"
          @test-node="testSingle"
          @toggle-collapse="toggleCollapse(group)"
          @toggle-hide-timeout="toggleHideTimeout(group)"
        />
      </template>

      <template v-if="autoGroups.length > 0 && (!normalizedFilter || anyVisibleMembers)">
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
          :pending="pendingSelection?.group === group ? pendingSelection.name : ''"
          :collapsed="collapsedGroups.has(group)"
          :hide-timeout="hideTimeoutGroups.has(group)"
          @test-group="testGroup(group)"
          @test-node="testSingle"
          @toggle-collapse="toggleCollapse(group)"
          @toggle-hide-timeout="toggleHideTimeout(group)"
        />
      </template>

      <div v-if="normalizedFilter && !anyVisibleMembers" class="empty-panel">
        <EmptyState icon="search" :title="t('proxies.noMatch')" />
      </div>

      <div v-else-if="selectorGroups.length === 0 && autoGroups.length === 0" class="empty-panel">
        <EmptyState
          icon="globe"
          :title="normalizedFilter ? t('proxies.noMatch') : t('proxies.noGroups')"
          :hint="normalizedFilter ? undefined : t('proxies.noGroupsHint')"
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
        :pending="pendingSelection?.group === 'GLOBAL' ? pendingSelection.name : ''"
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
          :title="normalizedFilter ? t('proxies.noMatch') : t('proxies.noGroups')"
          :hint="normalizedFilter ? undefined : t('proxies.noGroupsHint')"
        />
      </div>
    </template>

    <template v-else>
      <article class="direct-node" aria-current="true">
        <span class="direct-indicator" />
        <div class="direct-copy">
          <strong>DIRECT</strong>
          <span>{{ t('overview.modeDirect') }}</span>
        </div>
        <span class="direct-current">{{ t('proxies.currentTag') }}</span>
      </article>
      <p class="direct-hint">{{ t('proxies.directHint') }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import { useProxyGroupCollapse } from "../composables/proxy-group-collapse.js";
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
const { collapsedGroups, toggleCollapse } = useProxyGroupCollapse(
  computed(() => [...selectorGroups.value, ...autoGroups.value, "GLOBAL"]),
);
const hideTimeoutGroups = shallowRef(new Set<string>());
const pendingSelection = ref<{ group: string; name: string } | null>(null);

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
const anyVisibleMembers = computed(() =>
  [...selectorGroups.value, ...autoGroups.value].some((group) => membersOf(group).length > 0),
);

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
  if (nowOf(group) === name || pendingSelection.value) return;
  pendingSelection.value = { group, name };
  try {
    await selectGroupProxy(group, name);
    toast.success(t("toast.nodeOk", { name }));
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    pendingSelection.value = null;
  }
}
</script>

<style scoped>
.proxy-pane {
  min-width: 0;
  padding-bottom: 24px;
}
.proxy-pane-head {
  display: flex;
  min-height: 64px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
  padding: 4px 2px 13px;
  border-bottom: 1px solid var(--border);
}
.proxy-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.proxy-pane-head h2 {
  color: var(--text-primary);
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.015em;
}
.proxy-pane-head p {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 13px;
}
.proxy-filter {
  width: 240px;
  min-width: 160px;
  flex-shrink: 1;
}
.proxy-kind-heading {
  margin: 20px 0 9px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.empty-panel {
  overflow: hidden;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.direct-node {
  position: relative;
  display: flex;
  min-height: 82px;
  align-items: center;
  gap: 13px;
  padding: 13px 15px 13px 24px;
  overflow: hidden;
  background: var(--selection-soft);
  border: 1px solid var(--selection-border);
  border-radius: var(--radius-md);
}
.direct-indicator {
  position: absolute;
  top: 50%;
  left: 9px;
  width: 2px;
  height: 32px;
  border-radius: var(--radius-full);
  background: var(--selection);
  transform: translateY(-50%);
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
  padding: 3px 8px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--bg-card) 52%, transparent);
  color: var(--selection);
  font-size: 12px;
  font-weight: 650;
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
}
</style>
