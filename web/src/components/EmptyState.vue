<template>
  <div class="empty-state">
    <Icon :name="icon" :size="30" stroke-width="1.6" />
    <p class="empty-title">{{ title }}</p>
    <p v-if="hint" class="empty-hint">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
import Icon from "./Icon.vue";

defineProps<{ icon: string; title: string; hint?: string }>();
</script>
