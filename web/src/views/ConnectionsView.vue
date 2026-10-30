<template>
  <div class="connections-view">
    <PageHeader :title="t('page.connections.title')" :desc="t('page.connections.desc')">
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
      <div class="control-actions">
        <button
          type="button"
          class="btn btn-sm btn-secondary btn-pause"
          :class="{ 'btn-paused': paused }"
          :aria-pressed="paused"
          :aria-label="paused ? t('connections.resume') : t('connections.pause')"
          :title="paused ? t('connections.resume') : t('connections.pause')"
          @click="togglePause"
        >
          <Icon :name="paused ? 'play' : 'pause'" :size="13" />
          <span class="pause-label">{{ paused ? t('connections.resume') : t('connections.pause') }}</span>
        </button>
        <button
          type="button"
          class="btn btn-sm btn-danger-outline"
          :disabled="store.connections.length === 0"
          @click="closeAll"
        >
          {{ t('connections.closeAll') }} ({{ store.connections.length }})
        </button>
      </div>
    </PageHeader>

    <div class="connection-columns" role="toolbar" :aria-label="t('connections.sortLabel')">
      <button
        v-for="option in sortOptions"
        :key="option.key"
        type="button"
        class="sort-column"
        :class="[`sort-${option.key}`, { active: sortKey === option.key }]"
        :aria-pressed="sortKey === option.key"
        :aria-label="`${t(option.label)}${sortKey === option.key ? `: ${t(sortDesc ? 'common.descending' : 'common.ascending')}` : ''}`"
        @click="setSort(option.key)"
      >
        <span>{{ t(option.short) }}</span>
        <span class="sort-direction" aria-hidden="true">{{ sortKey === option.key ? (sortDesc ? '↓' : '↑') : '' }}</span>
      </button>
    </div>

    <div class="connection-list">
      <ConnectionRow
        v-for="connection in pagedConnections"
        :key="connection.id"
        v-memo="[connection.upload, connection.download, JSON.stringify(connection.metadata), connection.chains.join('\0'), connection.rule, connection.rulePayload, formatAgo(connection.start), locale]"
        :connection="connection"
        @close="closeOne"
      />

      <EmptyState
        v-if="!isCoreRunning"
        icon="swap"
        :title="t('connections.coreStopped')"
        :hint="t('connections.coreStoppedHint')"
      />
      <EmptyState
        v-else-if="!store.resourceLoaded.connections"
        icon="loader"
        :title="t('common.loading')"
      />
      <EmptyState
        v-else-if="filteredConnections.length === 0"
        icon="swap"
        :title="searchQuery.trim() ? t('connections.emptyMatch') : t('connections.empty')"
      />
    </div>

    <PaginationFooter v-model:page="currentPage" :pages="totalPages" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { confirmDialog } from "../components/confirm.js";
import ConnectionRow from "../components/ConnectionRow.vue";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import PaginationFooter from "../components/PaginationFooter.vue";
import { locale, t } from "../i18n/index.js";
import {
  closeAllConnections,
  closeConnection,
  errorText,
  isCoreRunning,
  store,
  toast,
} from "../stores/index.js";
import type { ConnectionItem } from "../types/index.js";
import { formatAgo, formatBytes } from "../utils/format.js";

const PAGE_SIZE = 80;
type SortKey = "time" | "upload" | "download" | "host";
// Listed in column order: host first, then the right-aligned traffic and age columns.
const sortOptions = [
  { key: "host", label: "connections.sortHost", short: "connections.sortHostShort" },
  { key: "download", label: "connections.sortDownload", short: "connections.sortDownloadShort" },
  { key: "upload", label: "connections.sortUpload", short: "connections.sortUploadShort" },
  { key: "time", label: "connections.sortTime", short: "connections.sortTimeShort" },
] as const;

const searchQuery = ref("");
const currentPage = ref(1);
const sortKey = ref<SortKey>("time");
const sortDesc = ref(true);
const paused = ref(false);
const pausedSnapshot = shallowRef<ConnectionItem[]>([]);

function togglePause(): void {
  if (!paused.value) {
    pausedSnapshot.value = [...store.connections];
  }
  paused.value = !paused.value;
}

function setSort(key: SortKey): void {
  if (sortKey.value === key) {
    sortDesc.value = !sortDesc.value;
  } else {
    sortKey.value = key;
    sortDesc.value = true;
  }
}

const activeConnections = computed(() =>
  paused.value ? pausedSnapshot.value : store.connections,
);

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
    ? activeConnections.value.filter((connection) => matchesConnection(connection, query))
    : [...activeConnections.value];
  const keyOf = (connection: ConnectionItem): number | string => {
    if (sortKey.value === "upload") return connection.upload;
    if (sortKey.value === "download") return connection.download;
    if (sortKey.value === "host") return hostOf(connection);
    return connection.start;
  };
  return list
    .map((connection) => ({ connection, key: keyOf(connection) }))
    .sort((a, b) => {
      const diff = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      return sortDesc.value ? -diff : diff;
    })
    .map((entry) => entry.connection);
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

async function closeOne(id: string): Promise<void> {
  try {
    await closeConnection(id);
    if (paused.value) {
      pausedSnapshot.value = pausedSnapshot.value.filter((connection) => connection.id !== id);
    }
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}

async function closeAll(): Promise<void> {
  const count = store.connections.length;
  const ok = await confirmDialog({
    title: t("connections.closeAll"),
    message: t("connections.closeAllConfirm", { n: count }),
    confirmText: t("common.confirm"),
    cancelText: t("common.cancel"),
    danger: true,
  });
  if (!ok) return;
  try {
    await closeAllConnections();
    pausedSnapshot.value = [];
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}
</script>

<style scoped>
/* Shared with ConnectionRow so the sort buttons sit directly above their columns. */
.connections-view {
  --connection-columns: minmax(0, 1fr) 76px 76px 72px 32px;
  min-height: 100%;
}
.connections-view > .page-head {
  margin-bottom: 0;
}
.connection-search {
  min-width: 0;
  flex: 1;
}
.connection-totals {
  flex-shrink: 0;
  padding: 5px 10px;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.control-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.btn-pause.btn-paused,
.btn-pause.btn-paused:hover:not(:disabled) {
  background: var(--warning-soft);
  border-color: var(--warning-border);
  color: var(--warning);
}
.connection-columns {
  position: sticky;
  top: 0;
  z-index: 5;
  display: grid;
  min-height: 36px;
  grid-template-columns: var(--connection-columns);
  align-items: center;
  column-gap: 12px;
  padding: 3px 14px 3px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-app);
}
.sort-column {
  display: inline-flex;
  height: 28px;
  align-items: center;
  justify-self: end;
  gap: 3px;
  margin: 0 -6px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
  transition:
    background var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}
.sort-column.sort-host {
  justify-self: start;
}
.sort-column:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.sort-column.active {
  color: var(--accent);
}
.sort-direction {
  min-width: 0.6em;
}
.connection-list {
  min-height: 180px;
}

@media (max-width: 899px) {
  .connection-search {
    flex-basis: 100%;
  }
  .control-actions {
    margin-left: auto;
  }
  .control-actions .btn {
    min-height: 38px;
  }
}

@media (max-width: 760px) {
  .connection-columns {
    display: flex;
    gap: 4px;
    padding: 6px 4px;
    overflow-x: auto;
  }
  .sort-column {
    height: 32px;
    margin: 0;
    padding: 0 10px;
    border: 1px solid var(--border);
    background: var(--bg-card);
  }
  .sort-column.active {
    border-color: var(--border-accent);
    background: var(--accent-soft);
  }
}

/* Phones: an icon-only pause keeps totals and actions on one line under the search box. */
@media (max-width: 480px) {
  .btn-pause {
    min-width: 38px;
    padding-inline: 0;
  }
  .pause-label {
    display: none;
  }
}
</style>
