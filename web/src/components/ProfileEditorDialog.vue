<template>
  <Teleport to="body">
    <Transition name="fade" appear>
      <div class="editor-overlay" @click.self="requestClose">
        <div class="editor-dialog" role="dialog" aria-modal="true" :aria-label="t('editor.title')">
          <header class="editor-head">
            <span class="editor-name" :title="profileName">{{ profileName }}</span>
            <span v-if="isRemote" class="editor-hint">{{ t("editor.remoteWarning") }}</span>
            <div class="editor-actions">
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                :disabled="saving"
                @click="requestClose"
              >
                {{ t("common.cancel") }}
              </button>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                :disabled="loading || saving || loadError !== null"
                @click="save"
              >
                {{ saving ? t("editor.saving") : t("common.save") }}
              </button>
            </div>
          </header>
          <div v-if="loadError" class="editor-error" role="alert">{{ loadError }}</div>
          <div v-show="!loadError" ref="hostElement" class="editor-host">
            <span v-if="loading" class="editor-loading">{{ t("common.loading") }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { StreamLanguage } from "@codemirror/language";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, basicSetup } from "codemirror";
import { onMounted, onUnmounted, ref } from "vue";
import { api } from "../api/index.js";
import { t } from "../i18n/index.js";
import { errorText, toast, writeProfileContent } from "../stores/index.js";
import { isDarkTheme } from "../theme.js";
import { confirmDialog } from "./confirm.js";

const props = defineProps<{
  profileId: string;
  profileName: string;
  isRemote: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const hostElement = ref<HTMLElement | null>(null);
const loading = ref(true);
const saving = ref(false);
const loadError = ref<string | null>(null);

let view: EditorView | null = null;
let pristineText = "";

function createEditor(content: string): void {
  if (!hostElement.value) return;
  const dark = isDarkTheme();
  view = new EditorView({
    parent: hostElement.value,
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        StreamLanguage.define(yaml),
        EditorView.theme({}, { dark }),
        EditorView.lineWrapping,
        ...(dark ? [oneDark] : []),
      ],
    }),
  });
  view.focus();
}

function currentText(): string {
  return view?.state.doc.toString() ?? "";
}

async function requestClose(): Promise<void> {
  if (saving.value) return;
  if (currentText() !== pristineText) {
    const discard = await confirmDialog({
      title: t("editor.title"),
      message: t("editor.discardConfirm"),
      confirmText: t("common.confirm"),
      cancelText: t("common.cancel"),
      danger: true,
    });
    if (!discard) return;
  }
  emit("close");
}

async function save(): Promise<void> {
  if (saving.value || loading.value || loadError.value !== null) return;
  saving.value = true;
  try {
    await writeProfileContent(props.profileId, currentText());
    toast.success(t("toast.profileSaved", { name: props.profileName }));
    emit("close");
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    saving.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    void requestClose();
  }
}

let previousBodyOverflow: string | null = null;

onMounted(async () => {
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  window.addEventListener("keydown", onKeydown);
  try {
    const result = await api.getProfileContent(props.profileId);
    pristineText = result.content;
    loading.value = false;
    createEditor(result.content);
  } catch (error) {
    loadError.value = errorText(error);
    loading.value = false;
  }
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  if (previousBodyOverflow !== null) {
    document.body.style.overflow = previousBodyOverflow;
    previousBodyOverflow = null;
  }
  view?.destroy();
  view = null;
});
</script>

<style scoped>
.editor-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  padding: 26px;
  background: var(--bg-scrim);
}
.editor-dialog {
  display: flex;
  width: 100%;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-elevated);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
}
.editor-head {
  display: flex;
  min-height: 46px;
  align-items: center;
  gap: 12px;
  padding: 6px 10px 6px 16px;
  border-bottom: 1px solid var(--border);
}
.editor-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editor-hint {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--warning);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editor-actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  margin-left: auto;
}
.editor-error {
  padding: 18px 20px;
  color: var(--danger);
  font-size: 16px;
}
.editor-host {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}
.editor-loading {
  position: absolute;
  top: 12px;
  left: 16px;
  color: var(--text-muted);
  font-size: 16px;
}
.editor-host :deep(.cm-editor) {
  height: 100%;
  font-size: 16px;
}
.editor-host :deep(.cm-editor .cm-scroller) {
  font-family: var(--font-mono);
}
.editor-host :deep(.cm-editor.cm-focused) {
  outline: none;
}

@media (max-width: 640px) {
  .editor-overlay {
    padding: 0;
  }
  .editor-dialog {
    border-radius: 0;
  }
  .editor-hint {
    display: none;
  }
}
</style>
