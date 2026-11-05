<template>
  <div class="core-status-row" :data-state="state">
    <CoreUpdateProgress />

    <div class="core-heading">
      <div class="core-identity" :title="coreTooltip">
        <span class="core-indicator" aria-hidden="true"><span class="core-dot" /></span>
        <span class="core-label">Core</span>
      </div>
      <CoreControls />
    </div>

    <!-- The dot and the clock carry the state; this line stays quiet and centered. -->
    <div class="core-clock mono" :title="coreTooltip">
      <span class="sr-only">{{ t(`app.coreState.${state}`) }}</span>
      {{ uptime }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useCoreDisplay } from "../composables/core-display.js";
import { useCoreUptime } from "../composables/core-uptime.js";
import { t } from "../i18n/index.js";
import { store } from "../stores/index.js";
import CoreControls from "./CoreControls.vue";
import CoreUpdateProgress from "./CoreUpdateProgress.vue";

const uptime = useCoreUptime();
const { state } = useCoreDisplay();
// The card shows no state word, so the tooltip and the screen-reader text carry it.
const coreTooltip = computed(() => {
  const status = t(`app.coreState.${state.value}`);
  return store.status?.core.pid ? `${status} · PID ${store.status.core.pid}` : status;
});
</script>

<style scoped>
.core-status-row {
  --core-tone: var(--text-muted);
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 7px;
}
.core-status-row[data-state="running"] {
  --core-tone: var(--success);
}
.core-status-row[data-state="starting"],
.core-status-row[data-state="stopping"] {
  --core-tone: var(--accent);
}
.core-status-row[data-state="unresponsive"] {
  --core-tone: var(--warning);
}
.core-heading,
.core-identity {
  display: flex;
  min-width: 0;
  align-items: center;
}
.core-heading {
  justify-content: space-between;
  gap: 8px;
}
.core-identity {
  gap: 8px;
}
.core-indicator {
  display: flex;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
}
.core-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--core-tone);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--core-tone) 18%, transparent);
  transition:
    background var(--motion-normal) var(--ease-standard),
    box-shadow var(--motion-normal) var(--ease-standard);
}
.core-status-row[data-state="stopped"] .core-dot {
  box-shadow: none;
}
/* A transition in progress breathes; settled states hold still. */
.core-status-row[data-state="starting"] .core-dot,
.core-status-row[data-state="stopping"] .core-dot {
  animation: core-pulse 1.2s var(--ease-standard) infinite;
}
@keyframes core-pulse {
  50% {
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--core-tone) 8%, transparent);
  }
}
.core-label {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
}
.core-clock {
  color: var(--text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  line-height: 1.4;
  text-align: center;
}
.core-status-row:is([data-state="running"], [data-state="unresponsive"]) .core-clock {
  color: var(--text-secondary);
}
.core-status-row :deep(.core-update-progress) {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  padding-bottom: 10px;
  margin-bottom: 2px;
  border-bottom: 1px solid var(--border);
}
</style>
