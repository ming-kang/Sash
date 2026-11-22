<template>
  <span class="mid-trunc" v-tooltip="text">
    <span class="mid-head">{{ head }}</span>
    <span class="mid-tail">{{ tail }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";

/**
 * Truncates in the middle (`very-lo…ample.com`) so the distinguishing tail —
 * TLD, port-adjacent segment, rule suffix — stays visible. Used for hosts,
 * URLs and rule payloads where end-ellipsis hides the useful part.
 */
const props = withDefaults(defineProps<{ text: string; tail?: number }>(), { tail: 12 });

const head = computed(() => {
  const text = props.text;
  if (text.length <= props.tail + 4) return text;
  return text.slice(0, text.length - props.tail);
});
const tail = computed(() =>
  props.text.length <= props.tail + 4 ? "" : props.text.slice(-props.tail),
);
</script>

<style scoped>
.mid-trunc {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  white-space: nowrap;
}
.mid-head {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mid-tail {
  flex-shrink: 0;
  white-space: nowrap;
}
</style>
