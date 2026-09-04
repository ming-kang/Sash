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
import { onUnmounted, ref, useId, watch } from "vue";
import { useDialogFocus } from "../composables/useDialogFocus.js";
import { acquireScrollLock, releaseScrollLock } from "../composables/useScrollLock.js";
import { currentRoute } from "../router.js";
import { confirmState, settleConfirm } from "./confirm.js";

const dialogElement = ref<HTMLElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
const confirmButton = ref<HTMLButtonElement | null>(null);
const id = useId();
const titleId = `${id}-title`;
const descriptionId = `${id}-description`;

let scrollLocked = false;

const { open, close } = useDialogFocus({
  container: dialogElement,
  initialFocus: () =>
    (confirmState.danger ? cancelButton.value : confirmButton.value) ?? cancelButton.value,
  onEscape: () => settleConfirm(false),
});

function lockScroll(): void {
  if (scrollLocked) return;
  acquireScrollLock();
  scrollLocked = true;
}

function unlockScroll(): void {
  if (!scrollLocked) return;
  releaseScrollLock();
  scrollLocked = false;
}

watch(
  () => confirmState.visible,
  async (visible) => {
    if (visible) {
      lockScroll();
      await open();
      return;
    }
    unlockScroll();
    close();
  },
  { immediate: true },
);

watch(currentRoute, () => {
  if (confirmState.visible) settleConfirm(false);
});

onUnmounted(() => {
  if (confirmState.visible) settleConfirm(false);
  unlockScroll();
  close();
});
</script>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-confirm);
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
  font-size: 20px;
  font-weight: 550;
}
.dialog-msg {
  margin-top: 9px;
  color: var(--text-secondary);
  font-size: 16px;
  line-height: 1.6;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 21px;
}
</style>
