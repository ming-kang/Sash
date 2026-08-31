<template>
  <section class="card ui-card">
    <header v-if="title || $slots.actions" class="ui-card-head">
      <div class="ui-card-heading">
        <h3 class="ui-card-title">{{ title }}</h3>
        <p v-if="desc" class="ui-card-desc">{{ desc }}</p>
      </div>
      <div v-if="$slots.actions" class="ui-card-actions">
        <slot name="actions" />
      </div>
    </header>
    <slot />
  </section>
</template>

<script setup lang="ts">
defineProps<{ title?: string; desc?: string }>();
</script>

<style scoped>
.ui-card {
  padding: 18px 20px;
}
.ui-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.ui-card-title {
  font-size: 14px;
  font-weight: 650;
}
.ui-card-desc {
  font-size: 12.5px;
  color: var(--text-muted);
  margin-top: 2px;
}
.ui-card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
</style>
