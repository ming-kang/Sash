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
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 22px;
}
.page-head-text {
  min-width: 0;
}
.page-title {
  color: var(--text-primary);
  font-size: clamp(21px, 2vw, 26px);
  font-weight: 750;
  letter-spacing: -0.025em;
  line-height: 1.2;
}
.page-desc {
  max-width: 720px;
  margin-top: 5px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}
.page-head-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 640px) {
  .page-head {
    flex-direction: column;
    gap: 12px;
    margin-bottom: 18px;
  }
  .page-head-actions {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
