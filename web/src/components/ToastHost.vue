<template>
  <Teleport to="body">
    <div class="toast-host" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="item in store.toasts" :key="item.id" class="toast" :class="`toast-${item.kind}`">
          <span class="toast-icon">
            <Icon :name="iconFor(item.kind)" :size="14" :stroke-width="2.2" />
          </span>
          <span class="toast-text">{{ item.text }}</span>
          <button class="toast-close" @click="dismissToast(item.id)">
            <Icon name="x" :size="12" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { dismissToast, store, type ToastItem } from "../stores/index.js";
import Icon from "./Icon.vue";

function iconFor(kind: ToastItem["kind"]): string {
  if (kind === "success") return "check-circle";
  if (kind === "error") return "alert";
  return "info";
}
</script>

<style scoped>
.toast-host {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(360px, calc(100vw - 32px));
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  padding: 10px 12px;
  font-size: 13px;
}
.toast-icon {
  display: flex;
  margin-top: 1px;
  flex-shrink: 0;
}
.toast-success .toast-icon {
  color: var(--success);
}
.toast-error .toast-icon {
  color: var(--danger);
}
.toast-info .toast-icon {
  color: var(--info);
}
.toast-text {
  flex: 1;
  line-height: 1.45;
  word-break: break-word;
}
.toast-close {
  display: flex;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  flex-shrink: 0;
}
.toast-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
