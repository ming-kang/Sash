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
  min-height: 78px;
  align-items: center;
  justify-content: space-between;
  gap: 12px 24px;
  margin: 0 calc(-1 * var(--page-gutter, 30px)) 18px;
  padding: 10px var(--header-pad, max(var(--page-gutter, 30px), 20px));
  border-bottom: 1px solid var(--border);
}
.page-head-text {
  min-width: 0;
}
.page-title {
  color: var(--text-primary);
  font-size: clamp(20px, 1.55vw, 23px);
  font-weight: 650;
  letter-spacing: -0.025em;
  line-height: 1.2;
}
.page-desc {
  max-width: 720px;
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.45;
}
.page-head-actions {
  display: flex;
  min-width: 0;
  align-items: center;
  flex: 1;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 899px) {
  .page-head {
    min-height: 0;
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
    padding: 18px var(--page-gutter, 16px) 16px;
  }
  .page-head-actions {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
