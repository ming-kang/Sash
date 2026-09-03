<template>
  <div class="connections-view">
    <header class="connections-toolbar">
      <h1>{{ t('page.connections.title') }}</h1>
      <div class="search-box connection-search">
        <Icon name="search" :size="13" />
        <input
          v-model="searchQuery"
          type="search"
          :aria-label="t('connections.searchPlaceholder')"
          :placeholder="t('connections.searchPlaceholder')"
        />
      </div>
      <div class="connection-totals mono">
        {{ t('connections.totalShort', {
          up: formatBytes(store.connectionsUploadTotal),
          down: formatBytes(store.connectionsDownloadTotal),
        }) }}
      </div>
      <button
        type="button"
        class="btn btn-sm close-all"
        :disabled="store.connections.length === 0"
        @click="closeAll"
      >
        {{ t('connections.closeAll') }} ({{ store.connections.length }})
      </button>
    </header>

    <div class="connection-list">
      <article v-for="connection in pagedConnections" :key="connection.id" class="connection-row">
        <div class="connection-main">
          <div class="connection-host mono" :title="hostOf(connection)">
            {{ hostOf(connection) }}
          </div>
          <div class="connection-tags">
            <span class="connection-tag tag-network">{{ connection.metadata.network.toUpperCase() }}</span>
            <span v-if="processName(connection) !== '-'" class="connection-tag tag-process" :title="connection.metadata.processPath">
              {{ processName(connection) }}
            </span>
            <span
              v-for="chain in connection.chains"
              :key="chain"
              class="connection-tag tag-chain"
            >
              {{ chain }}
            </span>
            <span class="connection-tag tag-rule" :title="connection.rulePayload">
              {{ connection.rule || '-' }}<template v-if="connection.rulePayload">,{{ connection.rulePayload }}</template>
            </span>
            <span class="connection-tag tag-time">{{ formatAgo(connection.start, locale) }}</span>
            <span class="connection-tag tag-traffic mono">
              ↑{{ formatBytes(connection.upload) }} ↓{{ formatBytes(connection.download) }}
            </span>
          </div>
        </div>
        <button
          type="button"
          class="connection-close"
          :aria-label="t('connections.closeTitle')"
          :title="t('connections.closeTitle')"
          @click="closeOne(connection.id)"
        >
          <Icon name="x" :size="18" />
        </button>
      </article>

      <EmptyState
        v-if="filteredConnections.length === 0"
        icon="swap"
        :title="t('connections.empty')"
      />
    </div>

    <footer v-if="filteredConnections.length > PAGE_SIZE" class="pagination-footer">
      <span class="pagination-summary">
        {{ t('common.pageSummary', { page: currentPage, total: totalPages }) }}
      </span>
      <div class="pagination-actions">
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          :disabled="currentPage === 1"
          @click="currentPage--"
        >
          {{ t('common.previous') }}
        </button>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          :disabled="currentPage === totalPages"
          @click="currentPage++"
        >
          {{ t('common.next') }}
        </button>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api/index.js";
import { confirmDialog } from "../components/confirm.js";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import { locale, t } from "../i18n/index.js";
import { errorText, store, toast } from "../stores/index.js";
import type { ConnectionItem } from "../types/index.js";
import { formatAgo, formatBytes } from "../utils/format.js";

const PAGE_SIZE = 80;
const searchQuery = ref("");
const currentPage = ref(1);

function matchesConnection(connection: ConnectionItem, query: string): boolean {
  const includes = (value: string | undefined): boolean =>
    Boolean(value?.toLowerCase().includes(query));

  return (
    includes(connection.metadata.host) ||
    includes(connection.metadata.destinationIP) ||
    includes(connection.metadata.sourceIP) ||
    includes(connection.metadata.processPath) ||
    includes(connection.metadata.network) ||
    includes(connection.rule) ||
    includes(connection.rulePayload) ||
    connection.chains.some((chain) => includes(chain))
  );
}

const filteredConnections = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  const list = query
    ? store.connections.filter((connection) => matchesConnection(connection, query))
    : [...store.connections];
  return list.sort((a, b) => b.start.localeCompare(a.start));
});
const totalPages = computed(() =>
  Math.max(1, Math.ceil(filteredConnections.value.length / PAGE_SIZE)),
);
const pageStart = computed(() => (currentPage.value - 1) * PAGE_SIZE);
const pageEnd = computed(() =>
  Math.min(pageStart.value + PAGE_SIZE, filteredConnections.value.length),
);
const pagedConnections = computed(() =>
  filteredConnections.value.slice(pageStart.value, pageEnd.value),
);

watch(searchQuery, () => {
  currentPage.value = 1;
});
watch(
  totalPages,
  (pages) => {
    currentPage.value = Math.min(currentPage.value, pages);
  },
  { immediate: true },
);

function hostOf(connection: ConnectionItem): string {
  if (connection.metadata.host) return connection.metadata.host;
  return `${connection.metadata.destinationIP}:${connection.metadata.destinationPort}`;
}

function processName(connection: ConnectionItem): string {
  const path = connection.metadata.processPath;
  return path ? (path.split(/[\\/]/).pop() ?? path) : "-";
}

async function closeOne(id: string): Promise<void> {
  try {
    await api.closeConnection(id);
    store.connections = store.connections.filter((connection) => connection.id !== id);
    toast.success(t("toast.connClosed"));
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}

async function closeAll(): Promise<void> {
  const ok = await confirmDialog({
    title: t("connections.closeAll"),
    message: t("connections.closeAllConfirm", { n: store.connections.length }),
    confirmText: t("common.confirm"),
    cancelText: t("common.cancel"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.closeAllConnections();
    store.connections = [];
    toast.success(t("toast.connAllClosed"));
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}
</script>

<style scoped>
.connections-view {
  min-height: 100%;
}
.connections-toolbar {
  display: grid;
  min-height: 79px;
  grid-template-columns: max-content minmax(220px, 1fr) max-content max-content;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
}
.connections-toolbar h1 {
  font-size: 20px;
  font-weight: 500;
}
.connection-search {
  min-width: 0;
}
.connection-totals {
  color: var(--text-primary);
  font-size: 12px;
  white-space: nowrap;
}
.close-all {
  background: #ef6468;
  color: #ffffff;
}
.close-all:hover:not(:disabled) {
  background: #dc565b;
}
.connection-list {
  min-height: 180px;
}
.connection-row {
  position: relative;
  display: flex;
  min-height: 49px;
  align-items: center;
  padding: 5px 46px 5px 20px;
  border-bottom: 1px solid var(--border);
}
.connection-row:hover {
  background: var(--general-row-hover);
}
.connection-main {
  min-width: 0;
  flex: 1;
}
.connection-host {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-tags {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 3px;
}
.connection-tag {
  display: inline-flex;
  max-width: 320px;
  min-height: 18px;
  align-items: center;
  padding: 1px 5px;
  overflow: hidden;
  border-radius: 3px;
  color: #ffffff;
  font-size: 9.5px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-network {
  background: #ce7838;
}
.tag-process {
  background: #bd8b32;
}
.tag-chain {
  background: #389d69;
}
.tag-rule {
  background: #69a95b;
}
.tag-time {
  background: #3b88df;
}
.tag-traffic {
  background: #4d14b8;
}
.connection-close {
  position: absolute;
  top: 50%;
  right: 20px;
  display: flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transform: translateY(-50%);
}
.connection-close:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.pagination-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 20px;
  border-top: 1px solid var(--border);
}
.pagination-summary {
  color: var(--text-muted);
  font-size: 11px;
}
.pagination-actions {
  display: flex;
  gap: 8px;
}

@media (max-width: 760px) {
  .connections-toolbar {
    grid-template-columns: 1fr auto;
    padding: 10px 6px;
  }
  .connection-search {
    grid-column: 1 / -1;
    grid-row: 2;
  }
  .connection-totals {
    grid-column: 1 / -1;
    grid-row: 3;
  }
  .connection-row {
    padding-right: 40px;
    padding-left: 8px;
  }
  .connection-close {
    right: 8px;
  }
}

@media (max-width: 480px) {
  .connection-tag {
    max-width: 220px;
  }
  .pagination-footer {
    align-items: stretch;
    flex-direction: column;
  }
  .pagination-actions .btn {
    flex: 1;
  }
}
</style>
