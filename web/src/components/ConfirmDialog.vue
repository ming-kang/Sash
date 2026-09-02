<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="confirmState.visible" class="overlay" @click.self="settleConfirm(false)">
        <div
          ref="dialogElement"
          class="dialog card"
          role="alertdialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :aria-describedby="descriptionId"
          tabindex="-1"
        >
          <h3 :id="titleId" class="dialog-title">{{ confirmState.title }}</h3>
          <p :id="descriptionId" class="dialog-msg">{{ confirmState.message }}</p>
          <div class="dialog-actions">
            <button
              ref="cancelButton"
              type="button"
              class="btn btn-secondary btn-sm"
              @click="settleConfirm(false)"
            >
              {{ confirmState.cancelText }}
            </button>
            <button
              ref="confirmButton"
              type="button"
              class="btn btn-sm"
              :class="confirmState.danger ? 'btn-danger' : 'btn-primary'"
              @click="settleConfirm(true)"
            >
              {{ confirmState.confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useId, watch } from "vue";
import { currentRoute } from "../router.js";
import { confirmState, settleConfirm } from "./confirm.js";

const dialogElement = ref<HTMLElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
const confirmButton = ref<HTMLButtonElement | null>(null);
const id = useId();
const titleId = `${id}-title`;
const descriptionId = `${id}-description`;

let triggerElement: HTMLElement | null = null;
let previousBodyOverflow: string | null = null;
let previousRootOverflow: string | null = null;

function lockBackgroundScroll(): void {
  if (previousBodyOverflow !== null) return;
  previousBodyOverflow = document.body.style.overflow;
  previousRootOverflow = document.documentElement.style.overflow;
  document.body.style.overflow = "hidden";
  document.documentElement.style.overflow = "hidden";
}

function restoreBackgroundScroll(): void {
  if (previousBodyOverflow === null || previousRootOverflow === null) return;
  document.body.style.overflow = previousBodyOverflow;
  document.documentElement.style.overflow = previousRootOverflow;
  previousBodyOverflow = null;
  previousRootOverflow = null;
}

function takeTriggerElement(): HTMLElement | null {
  const trigger = triggerElement;
  triggerElement = null;
  return trigger?.isConnected ? trigger : null;
}

function focusableElements(): HTMLElement[] {
  if (!dialogElement.value) return [];
  return Array.from(
    dialogElement.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("hidden"));
}

function onKeydown(event: KeyboardEvent): void {
  if (!confirmState.visible) return;
  if (event.key === "Escape") {
    event.preventDefault();
    settleConfirm(false);
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = focusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    dialogElement.value?.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (
    event.shiftKey &&
    (active === first || active === dialogElement.value || !dialogElement.value?.contains(active))
  ) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && (active === last || !dialogElement.value?.contains(active))) {
    event.preventDefault();
    first?.focus();
  }
}

watch(
  () => confirmState.visible,
  async (visible) => {
    if (visible) {
      triggerElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      lockBackgroundScroll();
      await nextTick();
      if (!confirmState.visible) return;
      const preferredButton = confirmState.danger ? cancelButton.value : confirmButton.value;
      (preferredButton ?? cancelButton.value ?? dialogElement.value)?.focus();
      return;
    }

    restoreBackgroundScroll();
    const trigger = takeTriggerElement();
    await nextTick();
    trigger?.focus({ preventScroll: true });
  },
  { immediate: true },
);

watch(currentRoute, () => {
  if (confirmState.visible) settleConfirm(false);
});

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  if (confirmState.visible) settleConfirm(false);
  restoreBackgroundScroll();
  takeTriggerElement()?.focus({ preventScroll: true });
});
</script>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: var(--bg-scrim);
}
.dialog {
  width: min(420px, 100%);
  padding: 20px 22px;
  background: var(--bg-elevated);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
}
.dialog-title {
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 550;
}
.dialog-msg {
  margin-top: 9px;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.6;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 21px;
}
</style>
