<template>
  <section class="card ui-card">
    <header v-if="title || desc || $slots.actions" class="ui-card-head">
      <div class="ui-card-heading">
        <h2 v-if="title" class="ui-card-title">{{ title }}</h2>
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
  padding: 20px 22px;
}
.ui-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.ui-card-heading {
  min-width: 0;
}
.ui-card-title {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.4;
}
.ui-card-desc {
  max-width: 680px;
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.ui-card-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 520px) {
  .ui-card {
    padding: 16px;
  }
  .ui-card-head {
    flex-wrap: wrap;
  }
}
</style>
