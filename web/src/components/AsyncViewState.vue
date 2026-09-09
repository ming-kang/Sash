<template>
  <section class="async-view-state" :role="error ? 'alert' : 'status'" :aria-busy="!error">
    <Icon :name="error ? 'alert' : 'loader'" :class="{ spin: !error }" :size="24" />
    <p>{{ error ? t('common.loadFailed') : t('common.loading') }}</p>
    <template v-if="error">
      <p class="async-hint">{{ t('common.reloadHint') }}</p>
      <button type="button" class="btn btn-secondary" @click="reload">{{ t('common.reload') }}</button>
    </template>
  </section>
</template>

<script setup lang="ts">
import { t } from "../i18n/index.js";
import Icon from "./Icon.vue";

defineProps<{ error?: Error }>();
function reload(): void {
  window.location.reload();
}
</script>

<style scoped>
.async-view-state {
  display: flex;
  min-height: 220px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  color: var(--text-primary);
  text-align: center;
}
.async-hint {
  color: var(--text-secondary);
}
</style>
