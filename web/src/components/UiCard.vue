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
  overflow: hidden;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
.ui-card-head {
  display: flex;
  min-height: 28px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px 10px;
}
.ui-card-heading {
  min-width: 0;
}
.ui-card-title {
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 650;
  line-height: 1.4;
}
.ui-card-desc {
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 13px;
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
  padding: 0 14px 12px;
  background: transparent;
}

@media (max-width: 520px) {
  .ui-card-head {
    flex-wrap: wrap;
  }
  .ui-card-head {
    padding: 15px 15px 9px;
  }
  .ui-card-body {
    padding: 0 10px 10px;
  }
}
</style>
