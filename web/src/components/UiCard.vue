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
  padding: 15px 17px;
  background: var(--bg-panel);
  border-color: var(--border);
  border-radius: var(--radius-md);
  box-shadow: none;
}
.ui-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.ui-card-heading {
  min-width: 0;
}
.ui-card-title {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0;
  line-height: 1.4;
}
.ui-card-desc {
  max-width: 680px;
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.45;
}
.ui-card-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 7px;
}

@media (max-width: 520px) {
  .ui-card {
    padding: 14px;
  }
  .ui-card-head {
    flex-wrap: wrap;
  }
}
</style>
