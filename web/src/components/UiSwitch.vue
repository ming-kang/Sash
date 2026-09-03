<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label ?? t('common.toggle')"
    class="switch"
    :class="{ on: modelValue }"
    :disabled="disabled"
    @click="$emit('update:modelValue', !modelValue)"
  >
    <span class="knob" aria-hidden="true" />
  </button>
</template>

<script setup lang="ts">
import { t } from "../i18n/index.js";

defineProps<{ modelValue: boolean; disabled?: boolean; label?: string }>();
defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<style scoped>
.switch {
  position: relative;
  width: 34px;
  height: 20px;
  flex-shrink: 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius-full);
  background: var(--switch-off);
  cursor: pointer;
  transition:
    background var(--motion-normal) var(--ease-standard),
    opacity var(--motion-fast) var(--ease-standard);
}
.switch:hover:not(:disabled) {
  background: color-mix(in srgb, var(--switch-off) 84%, var(--text-primary));
}
.switch:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}
.knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: var(--radius-full);
  background: var(--switch-knob-off);
  box-shadow: var(--shadow-switch);
  transition:
    background var(--motion-normal) var(--ease-standard),
    transform var(--motion-normal) var(--ease-spring);
}
.switch.on .knob {
  background: var(--switch-knob-on);
  transform: translateX(14px);
}
</style>
