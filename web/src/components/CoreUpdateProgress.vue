<template>
  <div v-if="coreUpdateText" class="core-update-progress">
    <span class="core-update-text">{{ coreUpdateText }}</span>
    <!-- Determinate only while the download size is known; other stages just show activity. -->
    <span
      class="core-update-bar"
      :class="{ indeterminate: percent === null }"
      role="progressbar"
      :aria-label="t('coreUpdate.progress')"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="percent ?? undefined"
    >
      <span class="core-update-fill" :style="percent === null ? undefined : { width: `${percent}%` }" />
    </span>
    <button
      v-if="store.status?.coreUpdate"
      type="button"
      class="btn btn-danger-outline btn-sm"
      :disabled="cancellingUpdate"
      @click="cancelCoreUpdate"
    >
      {{ t("settings.cancelUpdateBtn") }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { coreUpdateText, useCoreControl } from "../composables/core-runtime.js";
import { t } from "../i18n/index.js";
import { store } from "../stores/index.js";

const { cancellingUpdate, cancelCoreUpdate } = useCoreControl();
const percent = computed(() => {
  const update = store.status?.coreUpdate;
  if (!update?.downloading || !update.total) return null;
  return Math.min(100, Math.round((update.downloaded / update.total) * 100));
});
</script>

<style scoped>
.core-update-progress {
  gap: 10px;
}
.core-update-text {
  min-width: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.core-update-bar {
  position: relative;
  display: block;
  width: 100%;
  height: 4px;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--bg-active);
}
.core-update-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0;
  border-radius: inherit;
  background: var(--accent);
  transition: width var(--motion-normal) var(--ease-standard);
}
.core-update-bar.indeterminate .core-update-fill {
  width: 35%;
  animation: core-update-slide 1.3s var(--ease-standard) infinite;
}
@keyframes core-update-slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(290%);
  }
}
.core-update-progress .btn {
  flex-shrink: 0;
  align-self: flex-start;
}
</style>
