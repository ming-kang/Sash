<template>
  <div>
    <PageHeader :title="t('page.proxies.title')" :desc="t('page.proxies.desc')">
      <div class="search-box" style="width: 220px">
        <Icon name="search" :size="13" />
        <input v-model="searchQuery" type="text" :placeholder="t('proxies.searchPlaceholder')" />
      </div>
      <select v-model="sortBy" class="input input-sm sort-select" :aria-label="'sort'">
        <option value="default">{{ t('proxies.sortDefault') }}</option>
        <option value="delay">{{ t('proxies.sortDelay') }}</option>
        <option value="name">{{ t('proxies.sortName') }}</option>
      </select>
      <button class="btn btn-primary btn-sm" :disabled="testing || nodeList.length === 0" @click="testAll">
        <Icon name="zap" :size="13" :class="{ spin: testing }" />
        <span>{{ testing ? t('proxies.testing', { done: testedCount, total: testTotal }) : t('proxies.testAll') }}</span>
      </button>
    </PageHeader>

    <div v-if="store.proxyGroups.length === 0" class="card">
      <EmptyState
        icon="globe"
        :title="t('proxies.noGroups')"
        :hint="t('proxies.noGroupsHint')"
      />
    </div>

    <div v-else class="proxies-layout">
      <!-- Group list -->
      <aside class="group-list">
        <button
          v-for="group in store.proxyGroups"
          :key="group"
          class="group-item"
          :class="{ active: store.activeGroup === group }"
          @click="store.activeGroup = group"
        >
          <div class="group-item-top">
            <span class="group-item-name" :title="group">{{ group }}</span>
            <span class="badge badge-neutral">{{ store.proxies[group]?.type || 'Selector' }}</span>
          </div>
          <div class="group-item-now" :title="store.proxies[group]?.now">
            {{ store.proxies[group]?.now || '-' }}
          </div>
        </button>
      </aside>

      <!-- Nodes -->
      <div class="nodes-pane">
        <div class="nodes-meta">
          <span class="text-muted">{{ t('common.nodesCount', { n: filteredNodes.length }) }}</span>
          <span v-if="currentNow" class="text-muted mono current-now" :title="currentNow">
            {{ t('proxies.current', { name: currentNow }) }}
          </span>
        </div>

        <div v-if="filteredNodes.length === 0" class="card">
          <EmptyState
            icon="search"
            :title="t('proxies.emptyTitle')"
            :hint="t('proxies.emptyHint')"
          />
        </div>

        <div v-else class="nodes-grid">
          <button
            v-for="name in filteredNodes"
            :key="name"
            class="node-card"
            :class="{ selected: isSelected(name) }"
            @click="selectNode(name)"
          >
            <div class="node-top">
              <span class="node-type">{{ store.proxies[name]?.type || '-' }}</span>
              <span class="node-delay" :class="delayClass(name)">{{ delayText(name) }}</span>
            </div>
            <div class="node-name" :title="name">{{ name }}</div>
            <div class="node-foot">
              <span v-if="isSelected(name)" class="node-selected">
                <Icon name="check" :size="12" :stroke-width="2.6" />
              </span>
              <span v-else class="node-select-hint">{{ latencyBar(name) }}</span>
              <span
                class="node-test"
                :class="{ spin: testingSingle === name }"
                title="Test"
                @click.stop="testSingle(name)"
              >
                <Icon name="zap" :size="12" />
              </span>
            </div>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { api } from "../api/index.js";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import { t } from "../i18n/index.js";
import { errorText, proxyDelay, setProxies, store, toast, updateProxyDelay } from "../stores/index.js";
import { delayLevel } from "../utils/format.js";

const searchQuery = ref("");
const sortBy = ref<"default" | "delay" | "name">("default");
const testing = ref(false);
const testingSingle = ref("");
const testedCount = ref(0);
const testTotal = ref(0);

const groupData = computed(() => store.proxies[store.activeGroup]);
const nodeList = computed(() => groupData.value?.all ?? []);
const currentNow = computed(() => groupData.value?.now ?? "");

const filteredNodes = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  let list = nodeList.value;
  if (q) list = list.filter((n) => n.toLowerCase().includes(q));

  if (sortBy.value === "name") {
    return [...list].sort((a, b) => a.localeCompare(b));
  }
  if (sortBy.value === "delay") {
    return [...list].sort((a, b) => {
      const da = proxyDelay(a);
      const db = proxyDelay(b);
      const rank = (d: number | undefined) => (d === undefined ? 2 : d > 0 ? 0 : 1);
      const ra = rank(da);
      const rb = rank(db);
      if (ra !== rb) return ra - rb;
      return (da ?? 0) - (db ?? 0);
    });
  }
  return list;
});

function isSelected(name: string): boolean {
  return currentNow.value === name;
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

function latencyBar(name: string): string {
  const d = proxyDelay(name);
  if (d === undefined) return "";
  if (d <= 0) return "····";
  if (d < 200) return "▂▄▆█";
  if (d < 400) return "▂▄▆·";
  if (d < 800) return "▂▄··";
  return "▂···";
}

async function selectNode(name: string): Promise<void> {
  if (isSelected(name)) return;
  try {
    await api.selectProxy(store.activeGroup, name);
    const res = await api.getProxies();
    setProxies(res.proxies);
    toast.success(t("toast.nodeOk", { name }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

async function runDelayTest(name: string): Promise<void> {
  try {
    const res = await api.testProxyDelay(name);
    updateProxyDelay(name, res.delay);
  } catch {
    updateProxyDelay(name, 0);
  }
}

async function testAll(): Promise<void> {
  if (testing.value) return;
  testing.value = true;
  const nodes = [...nodeList.value];
  testTotal.value = nodes.length;
  testedCount.value = 0;
  const CONCURRENCY = 6;

  try {
    for (let i = 0; i < nodes.length; i += CONCURRENCY) {
      await Promise.all(
        nodes.slice(i, i + CONCURRENCY).map(async (name) => {
          await runDelayTest(name);
          testedCount.value += 1;
        }),
      );
    }
    toast.success(t("toast.testDone"));
  } finally {
    testing.value = false;
  }
}

async function testSingle(name: string): Promise<void> {
  if (testingSingle.value) return;
  testingSingle.value = name;
  try {
    await runDelayTest(name);
  } finally {
    testingSingle.value = "";
  }
}
</script>

<style scoped>
.sort-select {
  width: auto;
}

.proxies-layout {
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.group-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: sticky;
  top: 20px;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
}
.group-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  text-align: left;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    background 0.12s ease;
}
.group-item:hover {
  background: var(--bg-hover);
}
.group-item.active {
  border-color: var(--border-accent);
  background: var(--accent-soft);
}
.group-item-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.group-item-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-item-now {
  font-size: 11.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-item.active .group-item-now {
  color: var(--accent);
}

.nodes-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  margin-bottom: 10px;
}
.current-now {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}

.nodes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 10px;
}
.node-card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  text-align: left;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 11px 13px;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease,
    transform 0.12s ease;
}
.node-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-card);
}
.node-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.node-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.node-type {
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.node-delay {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
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
.node-name {
  font-size: 13px;
  font-weight: 550;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.8em;
  word-break: break-all;
}
.node-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 16px;
}
.node-selected {
  color: var(--accent);
  display: flex;
}
.node-select-hint {
  font-size: 10px;
  letter-spacing: 2px;
  color: #c6c9d1;
}
.node-test {
  display: flex;
  padding: 3px;
  border-radius: 5px;
  color: var(--text-muted);
  opacity: 0;
  transition:
    opacity 0.12s ease,
    background 0.12s ease;
}
.node-card:hover .node-test {
  opacity: 1;
}
.node-test:hover {
  background: var(--bg-inset);
  color: var(--accent);
}
.node-test.spin {
  opacity: 1;
  animation: rotate 0.9s linear infinite;
}

@media (max-width: 760px) {
  .proxies-layout {
    grid-template-columns: 1fr;
  }
  .group-list {
    position: static;
    flex-direction: row;
    overflow-x: auto;
    max-height: none;
  }
  .group-item {
    min-width: 150px;
  }
}
</style>
