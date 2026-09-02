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
  width: 42px;
  height: 24px;
  flex-shrink: 0;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-full);
  background: var(--switch-off);
  cursor: pointer;
  transition:
    background var(--motion-normal) var(--ease-standard),
    border-color var(--motion-normal) var(--ease-standard),
    box-shadow var(--motion-fast) var(--ease-standard);
}
.switch:hover:not(:disabled) {
  border-color: var(--text-muted);
}
.switch.on {
  background: var(--accent);
  border-color: var(--accent);
}
.switch:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}
.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-full);
  background: var(--switch-knob);
  box-shadow: var(--shadow-switch);
  transition: transform var(--motion-normal) var(--ease-spring);
}
.switch.on .knob {
  transform: translateX(18px);
}
</style>
