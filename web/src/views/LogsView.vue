<template>
  <div class="logs-view">
    <header class="logs-toolbar">
      <div class="logs-heading">
        <h1>{{ t('page.logs.title') }}</h1>
        <span>mode: {{ store.mode }}</span>
      </div>

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
        class="btn btn-sm log-clear"
        :disabled="store.logs.length === 0"
        @click="clearLogs"
      >
        {{ t('common.clear') }}
      </button>
      <button
        type="button"
        class="btn btn-sm log-pause"
        :aria-pressed="paused"
        @click="togglePaused"
      >
        {{ paused ? t('logs.resume') : t('logs.pause') }}
      </button>
    </header>

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
        {{ store.logs.length === 0 ? t('logs.listening') : t('logs.empty') }}
      </div>
      <div v-for="log in filteredLogs" :key="log.id" class="log-line" :class="`lv-${log.type.toLowerCase()}`">
        <Icon :name="levelIcon(log.type)" :size="13" class="log-icon" />
        <span class="log-payload">{{ log.payload }}</span>
        <span v-if="log.time" class="log-time mono">{{ log.time }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "../components/Icon.vue";
import { t } from "../i18n/index.js";
import { clearLogs, store } from "../stores/index.js";

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
  if (level === "warning") return "info";
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
.logs-toolbar {
  display: grid;
  min-height: 52px;
  grid-template-columns: max-content minmax(220px, 1fr) 100px auto auto;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
}
.logs-heading {
  min-width: 128px;
}
.logs-heading h1 {
  font-size: 20px;
  font-weight: 500;
  line-height: 1.2;
}
.logs-heading span {
  display: block;
  margin-top: 3px;
  color: var(--text-primary);
  font-size: 13px;
}
.logs-search {
  min-width: 0;
}
.level-select {
  min-height: 34px;
}
.log-clear {
  min-width: 70px;
  background: #239b20;
  color: #ffffff;
}
.log-clear:hover:not(:disabled) {
  background: #1d861b;
}
.log-pause {
  min-width: 70px;
  background: #ef6468;
  color: #ffffff;
}
.log-pause:hover:not(:disabled) {
  background: #dc565b;
}
.log-pane {
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  contain: layout paint;
  background: var(--bg-app);
  font-size: 12px;
}
.log-pane:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent);
}
.log-empty {
  padding: 14px 20px;
  font-size: 12.5px;
}
.log-line {
  display: grid;
  min-height: 27px;
  grid-template-columns: 14px minmax(0, 1fr) max-content;
  align-items: center;
  gap: 5px;
  padding: 3px 10px 3px 20px;
  border-bottom: 1px solid var(--border);
  contain: layout paint style;
  content-visibility: auto;
  contain-intrinsic-size: auto 27px;
  line-height: 1.35;
}
.log-line:hover {
  background: var(--general-row-hover);
}
.log-icon {
  flex-shrink: 0;
}
.log-time {
  color: var(--text-muted);
  font-size: 10.5px;
}
.log-payload {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-sans);
  font-size: 11.5px;
}
.lv-info {
  color: var(--success);
}
.lv-warning {
  color: var(--danger);
}
.lv-error {
  color: var(--danger);
}
.lv-debug {
  color: var(--log-debug);
}

@media (max-width: 899px) {
  .logs-view {
    height: calc(100dvh - 40px - 62px - env(safe-area-inset-bottom, 0px) - 8px);
  }
}

@media (max-width: 760px) {
  .logs-toolbar {
    grid-template-columns: 1fr auto auto;
    padding: 10px 6px;
  }
  .logs-heading {
    min-width: 0;
  }
  .logs-search {
    grid-column: 1 / -1;
    grid-row: 2;
  }
  .level-select {
    min-width: 90px;
  }
  .log-line {
    padding-left: 8px;
  }
}

@media (max-width: 480px) {
  .logs-toolbar {
    grid-template-columns: 1fr 1fr;
  }
  .logs-heading {
    grid-column: 1 / -1;
  }
  .level-select {
    grid-column: 1 / -1;
  }
  .log-clear,
  .log-pause {
    width: 100%;
  }
  .log-line {
    grid-template-columns: 14px minmax(0, 1fr);
  }
  .log-time {
    grid-column: 2;
  }
}
</style>
