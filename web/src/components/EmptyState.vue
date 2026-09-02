<template>
  <div class="empty-state" role="status">
    <span class="empty-icon" aria-hidden="true">
      <Icon :name="icon" :size="28" :stroke-width="1.7" />
    </span>
    <p class="empty-title">{{ title }}</p>
    <p v-if="hint" class="empty-hint">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
import Icon from "./Icon.vue";

defineProps<{ icon: string; title: string; hint?: string }>();
</script>

<style scoped>
.empty-state {
  display: flex;
  min-height: 220px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 7px;
  padding: 44px 20px;
  color: var(--text-muted);
  text-align: center;
}
.empty-icon {
  display: inline-flex;
  width: 54px;
  height: 54px;
  align-items: center;
  justify-content: center;
  margin-bottom: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-inset);
  color: var(--accent);
}
.empty-title {
  color: var(--text-secondary);
  font-size: 13.5px;
  font-weight: 650;
}
.empty-hint {
  max-width: 360px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.55;
}
</style>
