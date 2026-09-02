<template>
  <Teleport to="body">
    <div class="toast-host" aria-live="polite" aria-atomic="false" aria-relevant="additions text">
      <TransitionGroup name="toast">
        <div v-for="item in store.toasts" :key="item.id" class="toast" :class="`toast-${item.kind}`">
          <span class="toast-icon">
            <Icon :name="iconFor(item.kind)" :size="14" />
          </span>
          <span class="toast-text">{{ item.text }}</span>
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
  </Teleport>
</template>

<script setup lang="ts">
import { t } from "../i18n/index.js";
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
  top: max(16px, env(safe-area-inset-top, 0px));
  right: max(16px, env(safe-area-inset-right, 0px));
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(360px, calc(100vw - 32px));
  pointer-events: none;
}
.toast {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px 10px 14px;
  overflow: hidden;
  pointer-events: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
  color: var(--text-primary);
  font-size: 12.5px;
}
.toast::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--info);
  content: "";
}
.toast-success::before {
  background: var(--success);
}
.toast-error::before {
  background: var(--danger);
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

@media (max-width: 899px) {
  .toast-host {
    top: auto;
    right: max(12px, env(safe-area-inset-right, 0px));
    bottom: calc(72px + env(safe-area-inset-bottom, 0px));
    left: max(12px, env(safe-area-inset-left, 0px));
    width: auto;
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
