<template>
  <div class="core-controls">
    <!-- The Apply dock: a saved configuration waits, so the action reads as plain text. -->
    <button
      v-if="applyOnly"
      type="button"
      class="btn btn-primary btn-sm"
      :disabled="restarting || stopping || !store.status"
      :title="t('settings.restartDesc')"
      @click="restartCore"
    >
      <Icon name="refresh" :size="13" :class="{ spin: restarting }" />
      <span>{{ restarting ? t('common.loading') : t('settings.applyBtn') }}</span>
    </button>
    <template v-else>
      <button
        v-if="running"
        type="button"
        class="icon-btn"
        :disabled="restarting || stopping || !store.status"
        :title="`${t('settings.reloadBtn')} · ${t('settings.restartDesc')}`"
        :aria-label="t('settings.reloadBtn')"
        @click="restartCore"
      >
        <Icon name="refresh" :size="15" :class="{ spin: restarting }" />
      </button>
      <button
        v-else
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="restarting || stopping || !store.status"
        :title="t('settings.startBtn')"
        :aria-label="t('settings.startBtn')"
        @click="restartCore"
      >
        <Icon :name="restarting ? 'refresh' : 'play'" :size="13" :class="{ spin: restarting }" />
        <span>{{ restarting ? t('common.loading') : t('settings.startBtn') }}</span>
      </button>
      <button
        v-if="running || restarting"
        type="button"
        class="icon-btn core-stop"
        :disabled="stopping || !store.status"
        :title="t('settings.stopBtn')"
        :aria-label="t('settings.stopBtn')"
        @click="stopCore"
      >
        <Icon name="power" :size="15" :class="{ spin: stopping }" />
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useCoreControl } from "../composables/core-runtime.js";
import { t } from "../i18n/index.js";
import { store } from "../stores/index.js";
import Icon from "./Icon.vue";

defineProps<{ applyOnly?: boolean }>();
const { restarting, stopping, restartCore, stopCore } = useCoreControl();
const running = computed(() => Boolean(store.status?.core.running));
</script>

<style scoped>
.core-controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
/* Stopping drops every proxied connection, so the control stays quiet until it is aimed at. */
.core-stop:hover:not(:disabled) {
  background: var(--danger-soft);
  color: var(--danger);
}

@media (max-width: 899px) {
  .core-controls > .btn {
    min-height: 38px;
  }
  .core-controls > .icon-btn {
    width: 40px;
    height: 40px;
  }
}
</style>
