<template>
  <div class="empty-state" role="status">
    <span class="empty-icon" aria-hidden="true">
      <Icon :name="icon" :size="26" />
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
  min-height: 200px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 7px;
  padding: 38px 20px;
  color: var(--text-muted);
  text-align: center;
}
.empty-icon {
  display: inline-flex;
  width: 52px;
  height: 52px;
  align-items: center;
  justify-content: center;
  margin-bottom: 5px;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  color: var(--text-muted);
}
.empty-title {
  color: var(--text-secondary);
  font-size: 15px;
  font-weight: 550;
}
.empty-hint {
  max-width: 360px;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.55;
}
</style>
