<template>
  <section class="proxy-pane" :aria-label="t('proxies.title')">
    <header class="proxy-pane-head">
      <h2>{{ t('proxies.title') }}</h2>
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
      <EmptyState icon="globe" :title="t('proxies.coreStopped')" />
    </div>

    <div v-else-if="store.mode !== 'direct' && !store.resourceLoaded.proxies" class="empty-panel" aria-busy="true">
      <EmptyState icon="loader" :title="t('proxies.loading')" />
    </div>

    <article v-else-if="store.mode === 'direct'" class="direct-node" aria-current="true">
      <span class="direct-indicator" />
      <div class="direct-copy">
        <strong>DIRECT</strong>
      </div>
    </article>

    <template v-else>
      <template v-if="showGroups">
        <ProxyGroupSection
          v-for="group in displayGroups"
          :key="group.name"
          :group="group.name"
          :members="group.members"
          :selectable="group.selectable"
          :testing="testingGroups.has(group.name)"
          :testing-nodes="testingNodes"
          :busy="Boolean(store.operations.proxySelections[group.name])"
          :pending="pendingSelection?.group === group.name ? pendingSelection.name : ''"
          :collapsed="collapsedGroups.has(group.name)"
          :hide-timeout="hideTimeoutGroups.has(group.name)"
          @select="(name) => selectNode(group.name, name)"
          @test-group="testGroup(group.name)"
          @test-node="testSingle"
          @toggle-collapse="toggleCollapse(group.name)"
          @toggle-hide-timeout="toggleHideTimeout(group.name)"
        />
      </template>

      <div v-else class="empty-panel">
        <EmptyState
          :icon="normalizedFilter && store.mode === 'rule' ? 'search' : 'globe'"
          :title="normalizedFilter ? t('proxies.noMatch') : t('proxies.noGroups')"
        />
      </div>
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
  proxyDisplayGroups,
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
const hideTimeoutGroups = shallowRef(new Set<string>());
const pendingSelection = ref<{ group: string; name: string } | null>(null);

function toggleHideTimeout(group: string): void {
  const next = new Set(hideTimeoutGroups.value);
  if (next.has(group)) next.delete(group);
  else next.add(group);
  hideTimeoutGroups.value = next;
}
// One pass over all groups so every ProxyGroupSection gets a stable array
// reference; per-render membersOf() calls would defeat prop memoization.
const membersByGroup = computed(() => {
  const map = new Map<string, string[]>();
  for (const group of new Set([...store.proxyGroups, "GLOBAL"])) {
    map.set(group, filterMembers(store.proxies[group]?.all ?? []));
  }
  return map;
});

function membersOf(group: string): string[] {
  return membersByGroup.value.get(group) ?? [];
}

const displayGroups = computed(() =>
  proxyDisplayGroups(store.mode, store.proxies, store.proxyGroups, membersOf),
);
const { collapsedGroups, toggleCollapse } = useProxyGroupCollapse(
  computed(() => {
    const names = displayGroups.value.map((group) => group.name);
    if (!names.includes("GLOBAL")) names.push("GLOBAL");
    return names;
  }),
);
const anyVisibleMembers = computed(() =>
  displayGroups.value.some((group) => group.members.length > 0),
);
const showGroups = computed(
  () => displayGroups.value.length > 0 && (!normalizedFilter.value || anyVisibleMembers.value),
);

function filterMembers(members: string[]): string[] {
  if (!normalizedFilter.value) return members;
  return members.filter((name) => name.toLowerCase().includes(normalizedFilter.value));
}

function nowOf(name: string): string {
  return store.proxies[name]?.now ?? "";
}

async function selectNode(group: string, name: string): Promise<void> {
  if (nowOf(group) === name || pendingSelection.value) return;
  pendingSelection.value = { group, name };
  try {
    await selectGroupProxy(group, name);
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
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
  padding: 4px 2px 13px;
  border-bottom: 1px solid var(--border);
}
.proxy-pane-head h2 {
  color: var(--text-primary);
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.015em;
}
.proxy-filter {
  width: 240px;
  min-width: 160px;
  flex-shrink: 1;
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
