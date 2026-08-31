<template>
  <div class="logs-view">
    <div class="header-bar">
      <div class="header-info">
        <h2 class="title-text">Core Logs</h2>
        <span class="badge badge-neutral">{{ store.logs.length }} entries</span>
      </div>

      <div class="controls-bar">
        <div class="btn-group">
          <button
            v-for="lvl in levels"
            :key="lvl"
            class="btn btn-sm"
            :class="selectedLevel === lvl ? 'btn-primary' : 'btn-secondary'"
            @click="selectedLevel = lvl"
          >
            {{ lvl.toUpperCase() }}
          </button>
        </div>

        <button class="btn btn-secondary btn-sm" @click="store.logs = []">
          <Icon name="trash" size="13" />
          <span>Clear</span>
        </button>
      </div>
    </div>

    <!-- Terminal Box -->
    <div ref="terminalRef" class="terminal-box mt-4">
      <div v-if="filteredLogs.length === 0" class="log-line text-muted">
        Listening for core runtime log stream...
      </div>
      <div
        v-for="(log, idx) in filteredLogs"
        :key="idx"
        class="log-line"
      >
        <span v-if="log.time" class="log-time">{{ log.time }}</span>
        <span class="badge" :class="getLogBadgeClass(log.type)">
          {{ log.type.toUpperCase() }}
        </span>
        <span class="log-payload">{{ log.payload }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import Icon from "../components/Icon.vue";
import { store } from "../stores/index.js";

const levels = ["all", "info", "warning", "error", "debug"];
const selectedLevel = ref("all");
const terminalRef = ref<HTMLElement | null>(null);

const filteredLogs = computed(() => {
  if (selectedLevel.value === "all") return store.logs;
  return store.logs.filter((l) => l.type.toLowerCase() === selectedLevel.value.toLowerCase());
});

watch(
  () => store.logs.length,
  async () => {
    await nextTick();
    if (terminalRef.value) {
      terminalRef.value.scrollTop = terminalRef.value.scrollHeight;
    }
  },
);

function getLogBadgeClass(type: string): string {
  switch (type.toLowerCase()) {
    case "error":
      return "badge-danger";
    case "warning":
      return "badge-warning";
    case "info":
      return "badge-neutral";
    default:
      return "badge-neutral";
  }
}
</script>

<style scoped>
.logs-view {
  display: flex;
  flex-direction: column;
}
.mt-4 {
  margin-top: 16px;
}

.header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.title-text {
  font-size: 18px;
  font-weight: 700;
}

.controls-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-group {
  display: flex;
  gap: 4px;
}

.terminal-box {
  background: #020617;
  border: 1px solid var(--border-card);
  border-radius: var(--radius-md);
  padding: 16px;
  height: 520px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.log-line {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  line-height: 1.6;
  word-break: break-all;
}

.log-time {
  color: var(--text-dim);
  font-size: 11px;
  flex-shrink: 0;
}

.log-payload {
  color: #e2e8f0;
}
</style>
