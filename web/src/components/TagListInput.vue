<template>
  <div>
    <div class="tag-editor" :class="{ 'tag-editor--disabled': disabled }">
      <span v-for="(item, index) in modelValue" :key="`${item}-${index}`" class="tag">
        <span class="tag-text">{{ item }}</span>
        <button
          type="button"
          class="tag-remove"
          :aria-label="`${t('common.close')} ${item}`"
          :disabled="disabled"
          @click="remove(index)"
        >
          ×
        </button>
      </span>
      <input
        v-model="text"
        class="tag-input"
        type="text"
        :placeholder="placeholder"
        :disabled="disabled"
        :aria-label="placeholder"
        @keydown.enter.prevent="add"
        @keydown.,.prevent="add"
        @blur="add"
      />
    </div>
    <p v-if="error" class="tag-error" role="alert">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { t } from "../i18n/index.js";

const props = defineProps<{
  modelValue: string[];
  placeholder?: string;
  disabled?: boolean;
  validate?: (item: string) => string | undefined;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();

const text = ref("");
const error = ref<string>();

function add(): void {
  const item = text.value.trim();
  if (!item) return;
  const problem = props.validate?.(item);
  if (problem) {
    error.value = problem;
    return;
  }
  if (!props.modelValue.includes(item)) emit("update:modelValue", [...props.modelValue, item]);
  text.value = "";
  error.value = undefined;
}

function remove(index: number): void {
  emit(
    "update:modelValue",
    props.modelValue.filter((_, i) => i !== index),
  );
}
</script>

<style scoped>
.tag-editor {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  min-height: 32px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
}
.tag-editor--disabled {
  opacity: 0.56;
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  padding: 2px 4px 2px 7px;
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  font-size: 11px;
}
.tag-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-remove {
  padding: 0 3px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  line-height: 1.2;
}
.tag-remove:hover:not(:disabled) {
  color: var(--danger);
}
.tag-input {
  flex: 1;
  min-width: 90px;
  padding: 2px 4px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.tag-input::placeholder {
  color: var(--text-muted);
}
.tag-error {
  margin: 4px 0 0;
  color: var(--danger);
  font-size: 11px;
}
</style>
