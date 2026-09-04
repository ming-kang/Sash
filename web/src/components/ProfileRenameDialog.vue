<template>
  <Teleport to="body">
    <Transition name="fade" appear>
      <div class="rename-overlay" @click.self="emit('close')">
        <div
          ref="dialogElement"
          class="rename-dialog card"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
        >
          <h3 :id="titleId" class="rename-title">{{ t("profiles.renameTitle") }}</h3>
          <label class="rename-label" :for="inputId">{{ t("profiles.nameLabel") }}</label>
          <input
            :id="inputId"
            ref="inputElement"
            v-model="name"
            class="input rename-input"
            type="text"
            maxlength="120"
            :disabled="saving"
            @keydown.enter.prevent="save"
          />
          <div class="rename-actions">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="saving"
              @click="emit('close')"
            >
              {{ t("common.cancel") }}
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="saving || !name.trim() || name.trim() === initialName"
              @click="save"
            >
              {{ t("common.save") }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, useId } from "vue";
import { useDialogFocus } from "../composables/useDialogFocus.js";
import { acquireScrollLock, releaseScrollLock } from "../composables/useScrollLock.js";
import { t } from "../i18n/index.js";
import { errorText, renameProfile, toast } from "../stores/index.js";
import type { ProfileMeta } from "../types/index.js";

const props = defineProps<{ profile: ProfileMeta }>();
const emit = defineEmits<{ close: [] }>();

const id = useId();
const titleId = `${id}-title`;
const inputId = `${id}-input`;
const dialogElement = ref<HTMLElement | null>(null);
const inputElement = ref<HTMLInputElement | null>(null);
const initialName = props.profile.name;
const name = ref(initialName);
const saving = ref(false);

const { open, close } = useDialogFocus({
  container: dialogElement,
  initialFocus: () => {
    inputElement.value?.select();
    return inputElement.value;
  },
  onEscape: () => emit("close"),
});

onMounted(() => {
  acquireScrollLock();
  void open();
});
onUnmounted(() => {
  close();
  releaseScrollLock();
});

async function save(): Promise<void> {
  const next = name.value.trim();
  if (!next || next === initialName || saving.value) return;
  saving.value = true;
  try {
    await renameProfile(props.profile.id, next);
    toast.success(t("toast.settingSaved"));
    emit("close");
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.rename-overlay {
  position: fixed;
  z-index: var(--z-rename);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-scrim);
  inset: 0;
}
.rename-dialog {
  width: min(360px, calc(100vw - 32px));
  padding: 18px;
}
.rename-title {
  margin: 0 0 12px;
  font-size: 16px;
}
.rename-label {
  display: block;
  margin-bottom: 6px;
  color: var(--text-secondary);
  font-size: 14px;
}
.rename-input {
  width: 100%;
  margin-bottom: 14px;
}
.rename-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
</style>
