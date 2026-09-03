<template>
  <section class="ui-card">
    <header v-if="title || desc || $slots.actions" class="ui-card-head">
      <div class="ui-card-heading">
        <h2 v-if="title" class="ui-card-title">{{ title }}</h2>
        <p v-if="desc" class="ui-card-desc">{{ desc }}</p>
      </div>
      <div v-if="$slots.actions" class="ui-card-actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="ui-card-body">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{ title?: string; desc?: string }>();
</script>

<style scoped>
.ui-card {
  min-width: 0;
}
.ui-card-head {
  display: flex;
  min-height: 28px;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 5px;
}
.ui-card-heading {
  min-width: 0;
}
.ui-card-title {
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 400;
  line-height: 1.4;
}
.ui-card-desc {
  margin-top: 1px;
  color: var(--text-muted);
  font-size: 10.5px;
  line-height: 1.35;
}
.ui-card-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 7px;
}
.ui-card-body {
  padding: 6px 10px;
  background: var(--bg-panel);
  border-radius: 3px;
}

@media (max-width: 520px) {
  .ui-card-head {
    flex-wrap: wrap;
  }
  .ui-card-body {
    padding: 6px 8px;
  }
}
</style>
