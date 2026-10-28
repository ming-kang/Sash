<template>
  <div class="toast-host" aria-live="polite" aria-atomic="false" aria-relevant="additions text">
    <TransitionGroup name="toast">
      <div
        v-for="item in store.toasts"
        :key="item.id"
        class="toast"
        :class="`toast-${item.kind}`"
        :role="item.kind === 'error' ? 'alert' : 'status'"
        @pointerenter="setToastPaused(item.id, 'pointer', true)"
        @pointerleave="setToastPaused(item.id, 'pointer', false)"
        @focusin="setToastPaused(item.id, 'focus', true)"
        @focusout="setToastPaused(item.id, 'focus', false)"
      >
        <span class="toast-icon">
          <Icon :name="iconFor(item.kind)" :size="14" />
        </span>
        <span class="toast-text">{{ item.text }}</span>
        <span v-if="item.count > 1" class="toast-count" :aria-label="t('toast.repeated', { n: item.count })">
          ×{{ item.count }}
        </span>
        <button
          type="button"
          class="toast-close"
          :aria-label="t('common.close')"
          @click="dismissToast(item.id)"
        >
          <Icon name="x" :size="12" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { t } from "../i18n/index.js";
import { dismissToast, store, type ToastItem } from "../stores/index.js";
import { setToastPaused } from "../stores/toast.js";
import Icon from "./Icon.vue";

function iconFor(kind: ToastItem["kind"]): string {
  if (kind === "success") return "check-circle";
  if (kind === "error") return "alert";
  if (kind === "warning") return "warning";
  return "info";
}
</script>

<style scoped>
.toast-host {
  position: static;
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  position: relative;
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 9px;
  padding: 9px 9px 9px 12px;
  pointer-events: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  color: var(--text-primary);
  font-size: 13px;
}
.toast-success {
  border-color: var(--success-border);
}
.toast-warning {
  border-color: var(--warning-border);
}
.toast-error {
  border-color: var(--danger-border);
}
.toast-info {
  border-color: var(--info-border);
}
.toast-icon {
  display: flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--info);
}
.toast-success .toast-icon {
  color: var(--success);
}
.toast-warning .toast-icon {
  color: var(--warning);
}
.toast-error .toast-icon {
  color: var(--danger);
}
.toast-text {
  min-width: 0;
  flex: 1;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.toast-count {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: var(--bg-inset);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.35;
}
.toast-close {
  display: flex;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-right: -3px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.toast-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

@media (max-width: 899px) {
  .toast-host {
    position: static;
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: none;
  }
  .toast-enter-from,
  .toast-leave-to {
    transform: none;
  }
}
</style>
