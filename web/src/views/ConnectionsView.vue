<template>
  <div>
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
      <button
        class="btn btn-danger-outline btn-sm"
        :aria-label="t('connections.closeAll')"
        :disabled="store.connections.length === 0"
        @click="closeAll"
      >
        <Icon name="trash" :size="12" />
        <span>{{ t('connections.closeAll') }}</span>
      </button>
    </PageHeader>

    <div class="stat-chips">
      <div class="chip card">
        <span class="chip-label">{{ t('connections.active') }}</span>
        <span class="chip-value mono">{{ store.connections.length }}</span>
      </div>
      <div class="chip card">
        <span class="chip-label">{{ t('connections.totalDown') }}</span>
        <span class="chip-value mono down">{{ formatBytes(store.connectionsDownloadTotal) }}</span>
      </div>
      <div class="chip card">
        <span class="chip-label">{{ t('connections.totalUp') }}</span>
        <span class="chip-value mono up">{{ formatBytes(store.connectionsUploadTotal) }}</span>
      </div>
    </div>

    <div class="table-wrap connection-list mt-4">
      <table class="data-table">
        <thead>
          <tr>
            <th>{{ t('connections.colHost') }}</th>
            <th>{{ t('connections.colProcess') }}</th>
            <th>{{ t('connections.colNetwork') }}</th>
            <th>{{ t('connections.colChain') }}</th>
            <th>{{ t('connections.colRule') }}</th>
            <th class="num">{{ t('connections.colDown') }}</th>
            <th class="num">{{ t('connections.colUp') }}</th>
            <th>{{ t('connections.colAction') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in pagedConnections" :key="c.id">
            <td class="cell-truncate" :data-label="t('connections.colHost')">
              <div class="host-cell">
                <span class="mono host-main" :title="hostOf(c)">{{ hostOf(c) }}</span>
                <span class="host-sub text-muted mono"
                  >{{ c.metadata.sourceIP }}:{{ c.metadata.sourcePort }}</span
                >
              </div>
            </td>
            <td
              class="cell-truncate text-muted"
              :data-label="t('connections.colProcess')"
              :title="c.metadata.processPath"
            >
              {{ processName(c) }}
            </td>
            <td :data-label="t('connections.colNetwork')">
              <span class="badge badge-neutral">{{ c.metadata.network }}</span>
            </td>
            <td
              class="cell-truncate text-muted"
              :data-label="t('connections.colChain')"
              :title="c.chains.join(' → ')"
            >
              {{ c.chains.join(' → ') }}
            </td>
            <td :data-label="t('connections.colRule')">
              <span class="badge badge-accent">{{ c.rule || '-' }}</span>
            </td>
            <td class="cell-mono num" :data-label="t('connections.colDown')">
              {{ formatBytes(c.download) }}
            </td>
            <td class="cell-mono num" :data-label="t('connections.colUp')">
              {{ formatBytes(c.upload) }}
            </td>
            <td class="num action-cell" :data-label="t('connections.colAction')">
              <button
                class="btn btn-ghost btn-xs close-btn"
                :aria-label="t('connections.closeTitle')"
                :title="t('connections.closeTitle')"
                @click="closeOne(c.id)"
              >
                <Icon name="x" :size="12" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState
        v-if="filteredConnections.length === 0"
        icon="swap"
        :title="t('connections.empty')"
      />
      <footer v-else class="pagination-footer">
        <span class="pagination-summary">
          {{
            t('common.pageSummary', {
              page: currentPage,
              total: totalPages,
            })
          }}
        </span>
        <div class="pagination-actions">
          <button
            class="btn btn-secondary btn-sm"
            :aria-label="t('common.previous')"
            :disabled="currentPage === 1"
            @click="currentPage--"
          >
            {{ t('common.previous') }}
          </button>
          <button
            class="btn btn-secondary btn-sm"
            :aria-label="t('common.next')"
            :disabled="currentPage === totalPages"
            @click="currentPage++"
          >
            {{ t('common.next') }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api/index.js";
import { confirmDialog } from "../components/confirm.js";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import { t } from "../i18n/index.js";
import { errorText, store, toast } from "../stores/index.js";
import type { ConnectionItem } from "../types/index.js";
import { formatBytes } from "../utils/format.js";

const PAGE_SIZE = 80;
const searchQuery = ref("");
const currentPage = ref(1);

function matchesConnection(c: ConnectionItem, query: string): boolean {
  const includes = (value: string | undefined): boolean =>
    Boolean(value?.toLowerCase().includes(query));

  return (
    includes(c.metadata.host) ||
    includes(c.metadata.destinationIP) ||
    includes(c.metadata.sourceIP) ||
    includes(c.metadata.processPath) ||
    includes(c.metadata.network) ||
    includes(c.rule) ||
    includes(c.rulePayload) ||
    c.chains.some((chain) => includes(chain))
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

function hostOf(c: ConnectionItem): string {
  if (c.metadata.host) return c.metadata.host;
  return `${c.metadata.destinationIP}:${c.metadata.destinationPort}`;
}

function processName(c: ConnectionItem): string {
  const p = c.metadata.processPath;
  return p ? (p.split(/[\\/]/).pop() ?? p) : "-";
}

async function closeOne(id: string): Promise<void> {
  try {
    await api.closeConnection(id);
    store.connections = store.connections.filter((c) => c.id !== id);
    toast.success(t("toast.connClosed"));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

async function closeAll(): Promise<void> {
  const ok = await confirmDialog({
    title: t("connections.closeAll"),
    message: t("connections.closeAllConfirm", {
      n: store.connections.length,
    }),
    confirmText: t("common.confirm"),
    cancelText: t("common.cancel"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.closeAllConnections();
    store.connections = [];
    toast.success(t("toast.connAllClosed"));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}
</script>

<style scoped>
.connection-search {
  width: 240px;
}
.stat-chips {
  display: grid;
  max-width: 720px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.chip {
  display: flex;
  min-width: 0;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  background: var(--bg-panel);
  border-color: transparent;
  border-radius: var(--radius-sm);
  box-shadow: none;
}
.chip-label {
  color: var(--text-muted);
  font-size: 11.5px;
}
.chip-value {
  font-size: 13.5px;
  font-weight: 550;
}
.chip-value.down {
  color: var(--chart-down);
}
.chip-value.up {
  color: var(--chart-up);
}

.num {
  text-align: right;
}
.host-cell {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.host-main {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.host-sub {
  font-size: 11px;
}
.close-btn {
  color: var(--text-muted);
}
.close-btn:hover {
  color: var(--danger);
}
.pagination-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}
.pagination-summary {
  color: var(--text-muted);
  font-size: 12px;
}
.pagination-actions {
  display: flex;
  gap: 8px;
}

@media (max-width: 760px) {
  :deep(.page-head-actions) {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .connection-search {
    width: min(240px, 100%);
  }
  .connection-list {
    overflow: visible;
    border: 0;
    background: transparent;
    box-shadow: none;
  }
  .data-table,
  .data-table tbody,
  .data-table tr,
  .data-table td {
    display: block;
    width: 100%;
  }
  .data-table thead {
    display: none;
  }
  .data-table tbody {
    display: grid;
    gap: 10px;
  }
  .data-table tbody tr {
    position: relative;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    box-shadow: none;
  }
  .data-table td {
    display: grid;
    grid-template-columns: minmax(74px, 0.35fr) minmax(0, 1fr);
    align-items: baseline;
    gap: 10px;
    max-width: none;
    padding: 4px 0;
    border: 0;
    text-align: left;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .data-table td::before {
    content: attr(data-label);
    color: var(--text-muted);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .data-table .action-cell {
    position: absolute;
    top: 8px;
    right: 8px;
    display: block;
    width: auto;
    padding: 0;
  }
  .data-table .action-cell::before {
    display: none;
  }
  .data-table td:first-child {
    padding-right: 38px;
  }
  .close-btn {
    min-width: 36px;
    min-height: 36px;
  }
  .pagination-footer {
    margin-top: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
  }
}

@media (max-width: 480px) {
  :deep(.page-head) {
    flex-direction: column;
  }
  :deep(.page-head-actions) {
    width: 100%;
    justify-content: flex-start;
  }
  .connection-search {
    width: 100%;
    flex-basis: 100%;
  }
  .stat-chips {
    grid-template-columns: 1fr;
  }
  .pagination-footer {
    align-items: stretch;
    flex-direction: column;
  }
  .pagination-actions .btn {
    flex: 1;
    min-height: 40px;
  }
}
</style>
