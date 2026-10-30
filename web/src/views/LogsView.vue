<template>
  <div class="logs-view">
    <PageHeader :title="t('page.logs.title')" :desc="t('page.logs.desc')">
      <div class="search-box logs-search">
        <Icon name="search" :size="13" />
        <input
          v-model="searchQuery"
          type="search"
          :aria-label="t('logs.searchPlaceholder')"
          :placeholder="t('logs.searchPlaceholder')"
        />
      </div>

      <select v-model="selectedLevel" class="input input-sm level-select" :aria-label="t('logs.levelLabel')">
        <option v-for="level in levels" :key="level" :value="level">
          {{ level === 'all' ? t('logs.levelAll') : level.toUpperCase() }}
        </option>
      </select>

      <button
        type="button"
        class="btn btn-sm btn-secondary log-clear"
        :disabled="store.logs.length === 0"
        @click="clearLogs"
      >
        {{ t('common.clear') }}
      </button>
      <button
        type="button"
        class="btn btn-sm btn-secondary log-pause"
        :class="{ active: paused }"
        :aria-pressed="paused"
        @click="togglePaused"
      >
        <Icon :name="paused ? 'play' : 'pause'" :size="13" />
        {{ paused ? t('logs.resume') : t('logs.pause') }}
      </button>
    </PageHeader>

    <div
      ref="paneRef"
      class="log-pane"
      role="log"
      tabindex="0"
      aria-live="off"
      aria-atomic="false"
      :aria-label="t('page.logs.title')"
      @scroll="onScroll"
    >
      <div v-if="filteredLogs.length === 0" class="log-empty text-muted">
        {{ !isCoreRunning ? t('logs.coreStopped') : store.logs.length === 0 ? t('logs.listening') : t('logs.empty') }}
      </div>
      <div v-for="log in filteredLogs" :key="log.id" class="log-line" :class="`lv-${log.type.toLowerCase()}`">
        <span v-if="log.time" class="log-time mono">{{ log.time }}</span>
        <Icon :name="levelIcon(log.type)" :size="13" class="log-icon" />
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
import { clearLogs, isCoreRunning, store } from "../stores/index.js";

const levels = ["all", "info", "warning", "error", "debug"];
const selectedLevel = ref("all");
const searchQuery = ref("");
const paused = ref(false);
const paneRef = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);
let scrollFrame: number | null = null;
let disposed = false;

const filteredLogs = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  return store.logs.filter((log) => {
    const levelMatches =
      selectedLevel.value === "all" || log.type.toLowerCase() === selectedLevel.value;
    return levelMatches && (!query || log.payload.toLowerCase().includes(query));
  });
});

function levelIcon(type: string): string {
  const level = type.toLowerCase();
  if (level === "error") return "alert";
  if (level === "warning") return "warning";
  if (level === "debug") return "terminal";
  return "check-circle";
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
  min-height: 0;
  flex-direction: column;
}
.logs-view > .page-head {
  margin-bottom: 0;
}
.logs-search {
  min-width: 0;
  flex: 1;
}
.level-select {
  width: 100px;
  min-height: 34px;
  flex-shrink: 0;
}
.log-clear,
.log-pause {
  min-width: 70px;
}
.log-pause.active,
.log-pause.active:hover:not(:disabled) {
  background: var(--warning-soft);
  border-color: var(--warning-border);
  color: var(--warning);
}
.log-pane {
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  contain: layout paint;
  background: var(--bg-card);
  font-size: 14px;
}
.log-pane:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent);
}
.log-empty {
  display: flex;
  min-height: 180px;
  align-items: center;
  justify-content: center;
  padding: 20px;
  font-size: 14px;
  text-align: center;
}
/* Time leads the row so entries scan chronologically and wrap without a separate time line on phones. */
.log-line {
  display: grid;
  min-height: 27px;
  grid-template-columns: max-content 14px minmax(0, 1fr);
  align-items: baseline;
  gap: 8px;
  padding: 4px 20px;
  border-bottom: 1px solid var(--border);
  contain: layout paint style;
  content-visibility: auto;
  contain-intrinsic-size: auto 27px;
}
.log-line:hover {
  background: var(--general-row-hover);
}
.log-time {
  grid-column: 1;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}
.log-icon {
  grid-column: 2;
  align-self: center;
}
.log-payload {
  grid-column: 3;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
}
.lv-info .log-icon {
  color: var(--success);
}
.lv-warning .log-icon,
.lv-warning .log-payload {
  color: var(--warning);
}
.lv-error .log-icon,
.lv-error .log-payload {
  color: var(--danger);
}
.lv-debug .log-icon,
.lv-debug .log-payload {
  color: var(--log-debug);
}

/* Fill the space above the fixed bottom navigation and Apply dock; the header keeps its natural height. */
@media (max-width: 899px) {
  .logs-view {
    height: calc(100dvh - 78px - var(--dock-h, 0px) - env(safe-area-inset-bottom, 0px));
    min-height: 360px;
  }
  .logs-view > .page-head {
    margin-bottom: 14px;
  }
  .log-pane {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .logs-search,
  .level-select,
  .log-clear,
  .log-pause {
    min-height: 40px;
  }
  .log-line {
    padding-right: 10px;
    padding-left: 10px;
  }
}

@media (max-width: 480px) {
  .logs-search {
    flex-basis: 100%;
  }
  .log-line {
    display: block;
  }
  .log-time,
  .log-icon {
    display: inline-block;
    margin-right: 6px;
    vertical-align: -2px;
  }
  .log-time {
    vertical-align: baseline;
  }
}
</style>
