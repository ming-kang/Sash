<template>
  <div class="core-status-row">
    <CoreUpdateProgress />

    <div class="core-heading">
      <div class="core-identity" :title="coreTooltip">
        <span class="core-indicator">
          <span class="dot" :class="isCoreRunning ? 'dot-success' : 'dot-muted'" />
        </span>
        <span class="core-label">Core</span>
      </div>
      <CoreControls />
    </div>

    <div class="core-state">
      <span class="core-state-text">
        {{ isCoreRunning ? t('common.running') : t('common.stopped') }}
      </span>
      <template v-if="isCoreRunning">
        <span aria-hidden="true">·</span>
        <span class="core-uptime">
          <span class="sr-only">{{ t('overview.uptime') }}</span>
          {{ uptime }}
        </span>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useCoreUptime } from "../composables/core-uptime.js";
import { t } from "../i18n/index.js";
import { isCoreRunning, store } from "../stores/index.js";
import CoreControls from "./CoreControls.vue";
import CoreUpdateProgress from "./CoreUpdateProgress.vue";

const uptime = useCoreUptime();
const coreTooltip = computed(() => {
  const status = isCoreRunning.value ? t("app.coreRunning") : t("app.coreStopped");
  return store.status?.core.pid ? `${status} · PID ${store.status.core.pid}` : status;
});
</script>

<style scoped>
.core-status-row {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
}
.core-heading,
.core-identity,
.core-state {
  display: flex;
  min-width: 0;
  align-items: center;
}
.core-heading {
  justify-content: space-between;
  gap: 8px;
}
.core-identity {
  gap: 10px;
}
.core-indicator {
  display: flex;
  width: 30px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
}
.core-label {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
}
.core-state {
  gap: 6px;
  padding-left: 40px;
  color: var(--text-muted);
  font-size: 12px;
}
.core-state-text {
  color: var(--text-secondary);
}
.core-uptime {
  min-width: 0;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.core-status-row :deep(.core-update-progress) {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
</style>
