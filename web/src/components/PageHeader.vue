<template>
  <header class="page-head">
    <div class="page-head-text">
      <h1 class="page-title">{{ title }}</h1>
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
  min-height: 70px;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 16px;
  padding: 12px 0 11px;
  border-bottom: 1px solid var(--border);
}
.page-head-text {
  min-width: 0;
}
.page-title {
  color: var(--text-primary);
  font-size: clamp(19px, 1.55vw, 22px);
  font-weight: 500;
  letter-spacing: -0.015em;
  line-height: 1.2;
}
.page-desc {
  max-width: 720px;
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.45;
}
.page-head-actions {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 640px) {
  .page-head {
    min-height: 0;
    align-items: flex-start;
    flex-direction: column;
    gap: 11px;
    margin-bottom: 16px;
    padding: 18px 0 14px;
  }
  .page-head-actions {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
