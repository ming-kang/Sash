<template>
  <Teleport to="body">
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
          <span
            v-if="item.duration > 0"
            :key="item.count"
            class="toast-progress"
            :style="{ animationDuration: `${item.duration}ms` }"
            aria-hidden="true"
          />
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
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
  position: fixed;
  top: max(16px, env(safe-area-inset-top, 0px));
  right: max(16px, env(safe-area-inset-right, 0px));
  z-index: var(--z-toast);
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
  padding: 10px 12px 13px 14px;
  overflow: hidden;
  pointer-events: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
  color: var(--text-primary);
  font-size: 16px;
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
.toast-warning::before {
  background: var(--warning);
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
.toast-warning .toast-icon {
  color: var(--warning);
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
.toast-count {
  flex-shrink: 0;
  align-self: center;
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
.toast-progress {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  background: var(--info);
  animation-name: toast-progress;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
  transform-origin: left;
}
.toast-success .toast-progress {
  background: var(--success);
}
.toast-warning .toast-progress {
  background: var(--warning);
}
.toast:hover .toast-progress,
.toast:focus-within .toast-progress {
  animation-play-state: paused;
}
@keyframes toast-progress {
  from {
    transform: scaleX(1);
  }
  to {
    transform: scaleX(0);
  }
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
  .toast-progress {
    display: none;
  }
}
</style>
