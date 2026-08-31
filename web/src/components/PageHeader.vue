<template>
  <header class="page-head">
    <div class="page-head-text">
      <h2 class="page-title">{{ title }}</h2>
      <p v-if="desc" class="page-desc">{{ desc }}</p>
    </div>
    <div v-if="$slots.default" class="page-head-actions">
      <slot />
    </div>
  </header>
</template>

<script setup lang="ts">
defineProps<{ title: string; desc?: string }>();
</script>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}
.page-title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.page-desc {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 3px;
}
.page-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
</style>
