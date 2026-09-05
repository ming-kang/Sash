<template>
  <div v-if="store.tunError !== null" class="tun-feedback" role="alert">
    <p>{{ store.tunError }}</p>
    <button type="button" class="btn btn-secondary btn-sm" @click="store.tunError = null">
      {{ t('toast.dismissTunError') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { t } from "../i18n/index.js";
import { store } from "../stores/state.js";
</script>

<style scoped>
.tun-feedback {
  min-width: 0;
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.tun-feedback p {
  margin: 0 0 12px;
  white-space: pre-wrap;
}
.tun-feedback button {
  min-height: 44px;
  max-width: 100%;
  white-space: normal;
}
</style>
