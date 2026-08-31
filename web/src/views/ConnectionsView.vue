<template>
  <div class="connections-view">
    <!-- Stats Row -->
    <div class="stats-bar">
      <div class="glass-card stat-pill">
        <span class="pill-label">Active Connections</span>
        <span class="pill-value text-sky">{{ store.connections.length }}</span>
      </div>
      <div class="glass-card stat-pill">
        <span class="pill-label">Total Download</span>
        <span class="pill-value text-success">{{ formatSize(store.connectionsDownloadTotal) }}</span>
      </div>
      <div class="glass-card stat-pill">
        <span class="pill-label">Total Upload</span>
        <span class="pill-value text-warning">{{ formatSize(store.connectionsUploadTotal) }}</span>
      </div>
    </div>

    <!-- Controls Bar -->
    <div class="controls-bar mt-4">
      <div class="search-box">
        <Icon name="search" size="13" />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Filter by host, IP, process..."
          class="search-input"
        />
      </div>

      <button
        class="btn btn-danger btn-sm"
        :disabled="store.connections.length === 0"
        @click="closeAll"
      >
        <Icon name="trash" size="13" />
        <span>Close All</span>
      </button>
    </div>

    <!-- Connections Table -->
    <div class="data-table-wrap mt-4">
      <table class="data-table">
        <thead>
          <tr>
            <th>Host / Target</th>
            <th>Process</th>
            <th>Network</th>
            <th>Rule</th>
            <th>Chains</th>
            <th>Download</th>
            <th>Upload</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="filteredConnections.length === 0">
            <td colspan="8" class="text-center text-muted py-8">
              No active connections matching filter
            </td>
          </tr>
          <tr v-for="c in filteredConnections" :key="c.id">
            <td class="cell-mono font-bold" :title="c.metadata.host || c.metadata.destinationIP">
              {{ c.metadata.host || `${c.metadata.destinationIP}:${c.metadata.destinationPort}` }}
            </td>
            <td class="cell-proc text-muted">
              {{ c.metadata.processPath ? c.metadata.processPath.split(/[\\/]/).pop() : '-' }}
            </td>
            <td>
              <span class="badge badge-neutral">{{ c.metadata.network }}</span>
            </td>
            <td>
              <span class="badge badge-primary">{{ c.rule }}</span>
            </td>
            <td class="cell-chains text-muted" :title="c.chains.join(' → ')">
              {{ c.chains.join(' → ') }}
            </td>
            <td class="cell-mono">{{ formatSize(c.download) }}</td>
            <td class="cell-mono">{{ formatSize(c.upload) }}</td>
            <td>
              <button class="btn btn-xs btn-danger-outline" @click="closeOne(c.id)">
                ✕
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { api } from "../api/index.js";
import Icon from "../components/Icon.vue";
import { store } from "../stores/index.js";

const searchQuery = ref("");

const filteredConnections = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return store.connections;
  return store.connections.filter((c) => {
    const host = c.metadata.host || c.metadata.destinationIP;
    const proc = c.metadata.processPath || "";
    return host.toLowerCase().includes(q) || proc.toLowerCase().includes(q);
  });
});

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

async function closeOne(id: string): Promise<void> {
  try {
    await api.closeConnection(id);
    store.connections = store.connections.filter((c) => c.id !== id);
  } catch (err) {
    alert(`Failed to close connection: ${(err as Error).message}`);
  }
}

async function closeAll(): Promise<void> {
  if (!confirm("Close all active connections?")) return;
  try {
    await api.closeAllConnections();
    store.connections = [];
  } catch (err) {
    alert(`Failed to close all connections: ${(err as Error).message}`);
  }
}
</script>

<style scoped>
.connections-view {
  display: flex;
  flex-direction: column;
}
.mt-4 {
  margin-top: 16px;
}
.py-8 {
  padding-top: 32px;
  padding-bottom: 32px;
}
.text-center {
  text-align: center;
}

.stats-bar {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}

.stat-pill {
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pill-label {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pill-value {
  font-size: 20px;
  font-weight: 700;
  font-family: var(--font-mono);
}

.text-sky {
  color: #38bdf8;
}
.text-success {
  color: var(--color-success);
}
.text-warning {
  color: var(--color-warning);
}

.controls-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-input);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-sm);
  padding: 5px 10px;
  width: 260px;
}

.search-input {
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  width: 100%;
}

.cell-mono {
  font-family: var(--font-mono);
  font-size: 12px;
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.font-bold {
  font-weight: 600;
}

.cell-proc,
.cell-chains {
  max-width: 140px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
}
</style>
