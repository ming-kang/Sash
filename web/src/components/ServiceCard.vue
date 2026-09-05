<template>
  <UiCard v-if="store.serviceStatus?.supported !== false" :title="t('service.title')" class="service-card">
    <div class="service-heading">
      <span class="badge" :class="store.serviceStatus?.state === 'ready' ? 'badge-success' : 'badge-warning'" role="status">
        {{ t(`service.${store.serviceStatus?.state ?? 'unknown'}`) }}
      </span>
    </div>
    <p>{{ t('service.ownership') }}</p>
    <template v-if="store.serviceStatus?.state === 'ready'">
      <p>{{ t('service.nativeVersion') }}: <code>{{ store.serviceStatus.version ?? '-' }}</code></p>
      <p>{{ t('settings.coreVersion') }}: <code>{{ store.serviceStatus.coreVersion ?? '-' }}</code></p>
    </template>
    <template v-else>
      <p>{{ t(`service.guidance.${store.serviceStatus?.state ?? 'unknown'}`) }}</p>
      <template v-if="store.serviceStatus?.state === 'not-installed'">
        <p>{{ t('service.adminInstall') }}</p>
        <code>sash service install</code>
        <p>{{ t('service.normalStart') }}</p>
        <code>sash start</code>
      </template>
      <code v-else>sash service status</code>
    </template>
  </UiCard>
</template>

<script setup lang="ts">
import { t } from "../i18n/index.js";
import { store } from "../stores/state.js";
import UiCard from "./UiCard.vue";
</script>

<style scoped>
.service-card { min-width: 0; overflow-wrap: anywhere; }
.service-card p { margin: 8px 0; color: var(--text-secondary); font-size: 14px; line-height: 1.5; }
.service-card code { white-space: pre-wrap; }
.service-heading { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
