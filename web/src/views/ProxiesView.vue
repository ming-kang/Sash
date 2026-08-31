<template>
  <div class="proxies-view">
    <!-- Group Tabs Bar -->
    <div class="group-bar">
      <button
        v-for="group in store.proxyGroups"
        :key="group"
        class="group-tab"
        :class="{ active: store.activeGroup === group }"
        @click="store.activeGroup = group"
      >
        <span class="group-name">{{ group }}</span>
        <span class="group-type">{{ store.proxies[group]?.type || 'Selector' }}</span>
      </button>
    </div>

    <!-- Active Group Header -->
    <div class="action-header mt-4">
      <div class="header-info">
        <h2 class="title-group">{{ store.activeGroup }}</h2>
        <span class="badge badge-neutral">
          {{ currentNodeList.length }} nodes
        </span>
      </div>

      <div class="controls-row">
        <!-- Search Filter -->
        <div class="search-box">
          <Icon name="search" size="13" />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search nodes..."
            class="search-input"
          />
        </div>

        <!-- Latency Test Button -->
        <button
          class="btn btn-secondary btn-sm"
          :disabled="testingLatency"
          @click="testGroupLatency"
        >
          <Icon name="zap" size="13" />
          <span>{{ testingLatency ? 'Testing...' : 'Test Latency' }}</span>
        </button>
      </div>
    </div>

    <!-- Nodes Grid -->
    <div class="nodes-grid mt-4">
      <div
        v-for="nodeName in filteredNodes"
        :key="nodeName"
        class="glass-card node-card"
        :class="{ selected: isSelected(nodeName) }"
        @click="selectNode(nodeName)"
      >
        <div class="node-top">
          <span class="node-type">{{ store.proxies[nodeName]?.type || 'Node' }}</span>
          <span class="badge" :class="getLatencyBadge(nodeName).cls">
            {{ getLatencyBadge(nodeName).text }}
          </span>
        </div>

        <div class="node-bottom">
          <span class="node-name" :title="nodeName">{{ nodeName }}</span>
          <div v-if="isSelected(nodeName)" class="check-icon">
            <Icon name="check" size="13" />
          </div>
        </div>
      </div>
    </div>

    <!-- Empty State -->
    <div v-if="filteredNodes.length === 0" class="empty-state">
      <Icon name="globe" size="36" />
      <p class="mt-2 text-muted">No proxies found matching your search.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { api } from "../api/index.js";
import Icon from "../components/Icon.vue";
import { store, updateProxyDelay } from "../stores/index.js";

const searchQuery = ref("");
const testingLatency = ref(false);

const currentGroupData = computed(() => {
  return store.proxies[store.activeGroup];
});

const currentNodeList = computed(() => {
  return currentGroupData.value?.all ?? [];
});

const filteredNodes = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return currentNodeList.value;
  return currentNodeList.value.filter((n) => n.toLowerCase().includes(q));
});

function isSelected(name: string): boolean {
  return currentGroupData.value?.now === name;
}

function getLatencyBadge(name: string): { text: string; cls: string } {
  const item = store.proxies[name];
  const history = item?.history ?? [];
  const delay = history.length > 0 ? history[history.length - 1]?.delay : undefined;

  if (delay === undefined) return { text: "--", cls: "badge-neutral" };
  if (delay === 0) return { text: "Timeout", cls: "badge-danger" };
  if (delay < 300) return { text: `${delay} ms`, cls: "badge-success" };
  if (delay < 600) return { text: `${delay} ms`, cls: "badge-warning" };
  return { text: `${delay} ms`, cls: "badge-danger" };
}

async function selectNode(name: string): Promise<void> {
  if (isSelected(name)) return;
  try {
    await api.selectProxy(store.activeGroup, name);
    const res = await api.getProxies();
    store.proxies = res.proxies;
  } catch (err) {
    alert(`Failed to switch node: ${(err as Error).message}`);
  }
}

async function testGroupLatency(): Promise<void> {
  if (testingLatency.value) return;
  testingLatency.value = true;

  const nodes = [...currentNodeList.value];
  const concurrency = 5;
  const chunks: string[][] = [];

  for (let i = 0; i < nodes.length; i += concurrency) {
    chunks.push(nodes.slice(i, i + concurrency));
  }

  try {
    for (const chunk of chunks) {
      await Promise.all(
        chunk.map(async (name) => {
          try {
            const res = await api.testProxyDelay(name);
            updateProxyDelay(name, res.delay);
          } catch {
            updateProxyDelay(name, 0);
          }
        }),
      );
    }
  } finally {
    testingLatency.value = false;
  }
}
</script>

<style scoped>
.proxies-view {
  display: flex;
  flex-direction: column;
}

.mt-4 {
  margin-top: 16px;
}

.group-bar {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 6px;
}

.group-tab {
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-sm);
  padding: 6px 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.group-tab:hover {
  background: var(--bg-card-hover);
  border-color: #374151;
}

.group-tab.active {
  background: #0284c7;
  border-color: #0284c7;
  color: #ffffff;
}

.group-tab.active .group-name {
  color: #ffffff;
}

.group-tab.active .group-type {
  color: rgba(255, 255, 255, 0.7);
}

.group-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary);
}

.group-type {
  font-size: 11px;
  color: var(--text-muted);
}

.action-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.title-group {
  font-size: 18px;
  font-weight: 700;
}

.controls-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-input);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-sm);
  padding: 5px 10px;
  width: 200px;
}

.search-input {
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  width: 100%;
}

.nodes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
}

.node-card {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  cursor: pointer;
  background: var(--bg-card-solid);
}

.node-card:hover {
  background: #1f2937;
  border-color: #374151;
}

.node-card.selected {
  border-color: #0284c7;
  background: rgba(2, 132, 199, 0.08);
}

.node-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.node-type {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.node-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.node-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.check-icon {
  color: #38bdf8;
  display: flex;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  color: var(--text-muted);
}
</style>
