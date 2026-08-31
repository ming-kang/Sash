<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="confirmState.visible" class="overlay" @click.self="settleConfirm(false)">
        <div class="dialog card" role="alertdialog" :aria-label="confirmState.title">
          <h3 class="dialog-title">{{ confirmState.title }}</h3>
          <p class="dialog-msg">{{ confirmState.message }}</p>
          <div class="dialog-actions">
            <button class="btn btn-secondary btn-sm" @click="settleConfirm(false)">
              {{ confirmState.cancelText }}
            </button>
            <button
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
import { confirmState, settleConfirm } from "./confirm.js";
</script>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(24, 26, 32, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.dialog {
  width: min(400px, 100%);
  padding: 20px;
  box-shadow: var(--shadow-pop);
}
.dialog-title {
  font-size: 14.5px;
  font-weight: 650;
}
.dialog-msg {
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.55;
}
.dialog-actions {
  margin-top: 18px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
