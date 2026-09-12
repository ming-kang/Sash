<template>
  <div class="core-controls">
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      :disabled="restarting || stopping || !store.status"
      @click="restartCore"
    >
      <Icon name="refresh" :size="13" :class="{ spin: restarting }" />
      <span v-if="restarting">{{ t('common.loading') }}</span>
      <span v-else>{{ store.status?.core.running ? t('settings.applyBtn') : t('settings.startBtn') }}</span>
    </button>
    <button
      v-if="!applyOnly"
      type="button"
      class="btn btn-danger-outline btn-sm"
      :disabled="stopping || !store.status || (!store.status.core.running && !restarting)"
      @click="stopCore"
    >
      <Icon name="power" :size="13" :class="{ spin: stopping }" />
      <span>{{ t('settings.stopBtn') }}</span>
    </button>
    <span v-if="coreUpdateText" class="core-update-progress">{{ coreUpdateText }}</span>
  </div>
</template>

<script setup lang="ts">
import { coreUpdateText, useCoreControl } from "../composables/core-runtime.js";
import { t } from "../i18n/index.js";
import { store } from "../stores/index.js";
import Icon from "./Icon.vue";

defineProps<{ applyOnly?: boolean }>();
const { restarting, stopping, restartCore, stopCore } = useCoreControl();
</script>

<style scoped>
.core-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.core-update-progress {
  flex-basis: 100%;
  font-size: 12px;
  opacity: 0.75;
}
</style>
