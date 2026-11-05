<template>
  <div v-if="coreUpdateText" class="core-update-progress">
    <span class="core-update-text">{{ coreUpdateText }}</span>
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
import { coreUpdateText, useCoreControl } from "../composables/core-runtime.js";
import { t } from "../i18n/index.js";
import { store } from "../stores/index.js";

const { cancellingUpdate, cancelCoreUpdate } = useCoreControl();
</script>

<style scoped>
.core-update-progress {
  gap: 12px;
}
.core-update-text {
  min-width: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.core-update-progress .btn {
  flex-shrink: 0;
}
</style>
