<template>
  <div>
    <PageHeader :title="t('page.connections.title')" :desc="t('page.connections.desc')">
      <div class="search-box" style="width: 240px">
        <Icon name="search" :size="13" />
        <input v-model="searchQuery" type="text" :placeholder="t('connections.searchPlaceholder')" />
      </div>
      <button
        class="btn btn-danger-outline btn-sm"
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

    <div class="table-wrap mt-4">
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
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in filteredConnections" :key="c.id">
            <td class="cell-truncate">
              <div class="host-cell">
                <span class="mono host-main" :title="hostOf(c)">{{ hostOf(c) }}</span>
                <span class="host-sub text-muted mono">{{ c.metadata.sourceIP }}:{{ c.metadata.sourcePort }}</span>
              </div>
            </td>
            <td class="cell-truncate text-muted" :title="c.metadata.processPath">
              {{ processName(c) }}
            </td>
            <td>
              <span class="badge badge-neutral">{{ c.metadata.network }}</span>
            </td>
            <td class="cell-truncate text-muted" :title="c.chains.join(' → ')">
              {{ c.chains.join(' → ') }}
            </td>
            <td>
              <span class="badge badge-accent">{{ c.rule || '-' }}</span>
            </td>
            <td class="cell-mono num">{{ formatBytes(c.download) }}</td>
            <td class="cell-mono num">{{ formatBytes(c.upload) }}</td>
            <td class="num">
              <button
                class="btn btn-ghost btn-xs close-btn"
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { api } from "../api/index.js";
import { confirmDialog } from "../components/confirm.js";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import { t } from "../i18n/index.js";
import { errorText, store, toast } from "../stores/index.js";
import type { ConnectionItem } from "../types/index.js";
import { formatBytes } from "../utils/format.js";

const searchQuery = ref("");

const filteredConnections = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const list = [...store.connections].sort(
    (a, b) => new Date(b.start).getTime() - new Date(a.start).getTime(),
  );
  if (!q) return list;
  return list.filter((c) => {
    const hay = [
      c.metadata.host,
      c.metadata.destinationIP,
      c.metadata.sourceIP,
      c.metadata.processPath,
      c.metadata.network,
      c.rule,
      c.rulePayload,
      c.chains.join(" "),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
});

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
.stat-chips {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.chip {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 14px;
  border-radius: var(--radius-md);
}
.chip-label {
  font-size: 12px;
  color: var(--text-muted);
}
.chip-value {
  font-size: 14px;
  font-weight: 650;
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
</style>
