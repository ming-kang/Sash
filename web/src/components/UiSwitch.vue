<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    class="switch"
    :class="{ on: modelValue }"
    :disabled="disabled"
    @click="$emit('update:modelValue', !modelValue)"
  >
    <span class="knob" />
  </button>
</template>

<script setup lang="ts">
defineProps<{ modelValue: boolean; disabled?: boolean }>();
defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<style scoped>
.switch {
  position: relative;
  width: 38px;
  height: 22px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: #e4e6ea;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}
.switch.on {
  background: var(--accent);
  border-color: var(--accent);
}
.switch:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.switch:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.18);
  transition: transform 0.16s ease;
}
.switch.on .knob {
  transform: translateX(16px);
}
</style>
