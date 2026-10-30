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
        <Icon :name="iconFor(item.kind)" :size="15" class="toast-icon" />
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
/* Notices rise from the bottom edge, away from page headers and their controls. */
.toast-host {
  position: fixed;
  right: max(24px, env(safe-area-inset-right, 0px));
  bottom: max(24px, env(safe-area-inset-bottom, 0px));
  z-index: var(--z-toast);
  display: flex;
  width: min(380px, calc(100vw - 48px));
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
}
.toast {
  display: flex;
  max-width: 100%;
  min-height: 40px;
  align-items: center;
  gap: 8px;
  padding: 7px 7px 7px 12px;
  pointer-events: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card-hover);
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.45;
}
.toast-icon {
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
  overflow-wrap: anywhere;
}
.toast-count {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: var(--bg-inset);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.6;
}
.toast-close {
  display: flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard),
    opacity var(--motion-fast) var(--ease-standard);
}
.toast-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
/* Self-dismissing notices show their close button only on hover or keyboard focus; errors always do. */
@media (hover: hover) and (pointer: fine) {
  .toast:not(.toast-error) .toast-close {
    opacity: 0;
  }
  .toast:hover .toast-close,
  .toast:focus-within .toast-close {
    opacity: 1;
  }
}

.toast-enter-active,
.toast-move {
  transition:
    opacity var(--motion-normal) var(--ease-standard),
    transform var(--motion-normal) var(--ease-standard);
}
.toast-leave-active {
  transition: opacity var(--motion-fast) var(--ease-standard);
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.toast-leave-to {
  opacity: 0;
}

/* Phones stack notices above the bottom navigation and the Apply dock. */
@media (max-width: 899px) {
  .toast-host {
    right: max(12px, env(safe-area-inset-right, 0px));
    bottom: calc(76px + var(--dock-h, 0px) + env(safe-area-inset-bottom, 0px));
    left: max(12px, env(safe-area-inset-left, 0px));
    width: auto;
    align-items: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-move,
  .toast-leave-active {
    transition: none;
  }
  .toast-enter-from {
    transform: none;
  }
}
</style>
