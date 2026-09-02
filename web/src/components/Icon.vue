<template>
  <component
    :is="iconComponent"
    :size="normalizedSize"
    color="currentColor"
    class-name="sash-icon"
    aria-hidden="true"
    focusable="false"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { resolveIcon } from "./icons.js";

const props = withDefaults(defineProps<{ name: string; size?: number | string }>(), {
  size: 14,
});

const iconComponent = computed(() => resolveIcon(props.name));
const normalizedSize = computed(() =>
  typeof props.size === "number" ? `${props.size}px` : props.size,
);
</script>

<style scoped>
:deep(.sash-icon) {
  display: block;
  flex-shrink: 0;
}
</style>
