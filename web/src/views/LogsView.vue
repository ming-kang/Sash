<template>
  <div class="logs-view">
    <PageHeader :title="t('page.logs.title')" :desc="t('page.logs.desc')">
      <div class="segmented level-filter" role="group" :aria-label="t('page.logs.title')">
        <button
          v-for="lvl in levels"
          :key="lvl"
          class="segmented-item"
          :class="{ active: selectedLevel === lvl }"
          :aria-label="lvl === 'all' ? t('logs.levelAll') : lvl.toUpperCase()"
          :aria-pressed="selectedLevel === lvl"
          @click="selectedLevel = lvl"
        >
          {{ lvl === 'all' ? t('logs.levelAll') : lvl.toUpperCase() }}
        </button>
      </div>
      <button
        class="btn btn-secondary btn-sm"
        :aria-label="paused ? t('logs.resume') : t('logs.pause')"
        :aria-pressed="paused"
        @click="togglePaused"
      >
        <Icon :name="paused ? 'play' : 'pause'" :size="12" />
        <span>{{ paused ? t('logs.resume') : t('logs.pause') }}</span>
      </button>
      <button
        class="btn btn-secondary btn-sm"
        :aria-label="t('common.clear')"
        :disabled="store.logs.length === 0"
        @click="clearLogs"
      >
        <Icon name="trash" :size="12" />
        <span>{{ t('common.clear') }}</span>
      </button>
    </PageHeader>

    <div
      ref="paneRef"
      class="log-pane card"
      role="log"
      tabindex="0"
      aria-live="off"
      aria-atomic="false"
      :aria-label="t('page.logs.title')"
      @scroll="onScroll"
    >
      <div v-if="filteredLogs.length === 0" class="log-empty text-muted">
        {{ store.logs.length === 0 ? t('logs.listening') : t('logs.empty') }}
      </div>
      <div v-for="log in filteredLogs" :key="log.id" class="log-line">
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import { t } from "../i18n/index.js";
import { clearLogs, store } from "../stores/index.js";

const levels = ["all", "info", "warning", "error", "debug"];
const selectedLevel = ref("all");
const paused = ref(false);
const paneRef = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);
let scrollFrame: number | null = null;
let disposed = false;

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

async function scrollToBottom(): Promise<void> {
  await nextTick();
  if (disposed || paused.value || !stickToBottom.value) return;
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    const el = paneRef.value;
    if (el && !disposed && !paused.value && stickToBottom.value) el.scrollTop = el.scrollHeight;
  });
}

function togglePaused(): void {
  paused.value = !paused.value;
  if (!paused.value) void scrollToBottom();
}

watch(
  () => store.logs.at(-1)?.id,
  () => {
    if (!paused.value && stickToBottom.value) void scrollToBottom();
  },
);

onMounted(() => {
  void scrollToBottom();
});

onBeforeUnmount(() => {
  disposed = true;
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
});
</script>

<style scoped>
.logs-view {
  display: flex;
  height: 100%;
  flex-direction: column;
}
.log-pane {
  min-width: 0;
  min-height: 320px;
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  contain: layout paint;
  background: var(--bg-panel);
  border-radius: var(--radius-sm);
  box-shadow: none;
  font-size: 12px;
}
.log-pane:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.log-empty {
  padding: 8px 2px;
  font-size: 12.5px;
}
.log-line {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 10px;
  padding: 4px 5px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 68%, transparent);
  contain: layout paint style;
  content-visibility: auto;
  contain-intrinsic-size: auto 25px;
  line-height: 1.45;
}
.log-line:last-child {
  border-bottom: 0;
}
.log-line:hover {
  background: var(--bg-hover);
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
  min-width: 0;
  color: var(--text-primary);
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.segmented-item:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-ring);
}

@media (max-width: 899px) {
  /* Exact-fit height: sidebar top bar + fixed bottom nav + container padding. */
  .logs-view {
    height: calc(100dvh - 58px - 62px - env(safe-area-inset-bottom, 0px) - 8px);
  }
}

@media (max-width: 760px) {
  :deep(.page-head-actions) {
    min-width: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .level-filter {
    max-width: 100%;
    overflow-x: auto;
  }
  .segmented-item,
  :deep(.page-head-actions > .btn) {
    min-height: 36px;
  }
  .log-pane {
    min-height: 280px;
    padding: 8px;
  }
  .log-line {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 1px 10px;
    padding: 5px 2px;
  }
  .log-level {
    width: auto;
  }
  .log-payload {
    grid-column: 1 / -1;
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
  .level-filter {
    width: 100%;
  }
  .segmented-item {
    flex: 1 0 auto;
  }
  .log-pane {
    min-height: 260px;
  }
  .log-time {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
