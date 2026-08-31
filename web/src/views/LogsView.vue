<template>
  <div>
    <PageHeader :title="t('page.logs.title')" :desc="t('page.logs.desc')">
      <div class="segmented">
        <button
          v-for="lvl in levels"
          :key="lvl"
          class="segmented-item"
          :class="{ active: selectedLevel === lvl }"
          @click="selectedLevel = lvl"
        >
          {{ lvl === 'all' ? t('logs.levelAll') : lvl.toUpperCase() }}
        </button>
      </div>
      <button class="btn btn-secondary btn-sm" @click="paused = !paused">
        <Icon :name="paused ? 'play' : 'pause'" :size="12" />
        <span>{{ paused ? t('logs.resume') : t('logs.pause') }}</span>
      </button>
      <button class="btn btn-secondary btn-sm" :disabled="store.logs.length === 0" @click="store.logs = []">
        <Icon name="trash" :size="12" />
        <span>{{ t('common.clear') }}</span>
      </button>
    </PageHeader>

    <div ref="paneRef" class="log-pane card" @scroll="onScroll">
      <div v-if="filteredLogs.length === 0" class="log-empty text-muted">
        {{ store.logs.length === 0 ? t('logs.listening') : t('logs.empty') }}
      </div>
      <div v-for="(log, idx) in filteredLogs" :key="idx" class="log-line">
        <span v-if="log.time" class="log-time mono">{{ log.time }}</span>
        <span class="log-level mono" :class="`lv-${log.type.toLowerCase()}`">
          {{ levelLabel(log.type) }}
        </span>
        <span class="log-payload">{{ log.payload }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import { t } from "../i18n/index.js";
import { store } from "../stores/index.js";

const levels = ["all", "info", "warning", "error", "debug"];
const selectedLevel = ref("all");
const paused = ref(false);
const paneRef = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);

const filteredLogs = computed(() => {
  if (selectedLevel.value === "all") return store.logs;
  return store.logs.filter((l) => l.type.toLowerCase() === selectedLevel.value);
});

function levelLabel(type: string): string {
  const upper = type.toUpperCase();
  return upper === "WARNING" ? "WARN" : upper;
}

function onScroll(): void {
  const el = paneRef.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

watch(
  () => store.logs.length,
  async () => {
    if (paused.value || !stickToBottom.value) return;
    await nextTick();
    const el = paneRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);
</script>

<style scoped>
.log-pane {
  height: calc(100vh - 220px);
  min-height: 320px;
  overflow-y: auto;
  padding: 12px 14px;
  font-size: 12px;
  background: #fcfcfd;
}
.log-empty {
  padding: 8px 2px;
  font-size: 12.5px;
}
.log-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 2.5px 2px;
  border-radius: 4px;
  line-height: 1.5;
}
.log-line:hover {
  background: var(--bg-inset);
}
.log-time {
  color: var(--text-muted);
  font-size: 11px;
  flex-shrink: 0;
}
.log-level {
  width: 46px;
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
}
.lv-info {
  color: var(--info);
}
.lv-warning {
  color: var(--warning);
}
.lv-error {
  color: var(--danger);
}
.lv-debug {
  color: var(--text-muted);
}
.log-payload {
  color: var(--text-primary);
  word-break: break-all;
  font-family: var(--font-mono);
  font-size: 11.5px;
}
</style>
