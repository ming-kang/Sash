<template>
  <PageHeader :title="t('status.connectTitle')" />
  <section class="connection-panel">
    <p>{{ t("status.connectDescription") }}</p>
    <code class="mono">sash web</code>
  </section>
</template>

<script setup lang="ts">
import PageHeader from "../components/PageHeader.vue";
import { t } from "../i18n/index.js";
</script>

<style scoped>
.connection-panel {
  max-width: 640px;
  margin-top: 24px;
  padding: 24px;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 16px;
  line-height: 1.6;
}
.connection-panel code {
  display: block;
  margin-top: 16px;
  padding: 12px 16px;
  background: var(--bg-sidebar);
  color: var(--text-primary);
}
</style>
