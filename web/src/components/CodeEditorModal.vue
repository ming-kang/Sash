<template>
  <Teleport to="body">
    <Transition name="fade" appear>
      <div class="editor-overlay" @click.self="onOverlayClick">
        <div
          ref="dialogElement"
          class="editor-dialog"
          :class="{ 'editor-dialog-constrained': layout === 'constrained' }"
          role="dialog"
          aria-modal="true"
          :aria-label="ariaLabel ?? title"
        >
          <header class="editor-head">
            <span class="editor-name" :title="title">{{ title }}</span>
            <span v-if="hint" class="editor-hint">{{ hint }}</span>
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
          <div
            v-show="!loadError"
            ref="hostElement"
            class="editor-host"
            :class="{ 'editor-host-constrained': layout === 'constrained' }"
          >
            <span v-if="loading" class="editor-loading">{{ t("common.loading") }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { StreamLanguage } from "@codemirror/language";
import { json } from "@codemirror/legacy-modes/mode/javascript";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup, EditorView } from "codemirror";
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useDialogFocus } from "../composables/useDialogFocus.js";
import { acquireScrollLock, releaseScrollLock } from "../composables/useScrollLock.js";
import { t } from "../i18n/index.js";
import { isDarkTheme } from "../theme.js";
import { confirmDialog } from "./confirm.js";

const props = withDefaults(
  defineProps<{
    title: string;
    content: string;
    language: "json" | "yaml";
    loading: boolean;
    loadError: string | null;
    saving: boolean;
    ariaLabel?: string;
    hint?: string;
    layout?: "fill" | "constrained";
  }>(),
  { layout: "fill" },
);
const emit = defineEmits<{ save: [content: string]; close: [] }>();

const dialogElement = ref<HTMLElement | null>(null);
const hostElement = ref<HTMLElement | null>(null);

let view: EditorView | null = null;
let pristineText = "";

function createEditor(): void {
  if (view || !hostElement.value) return;
  const dark = isDarkTheme();
  view = new EditorView({
    parent: hostElement.value,
    state: EditorState.create({
      doc: props.content,
      extensions: [
        basicSetup,
        StreamLanguage.define(props.language === "yaml" ? yaml : json),
        EditorView.theme({}, { dark }),
        EditorView.lineWrapping,
        ...(dark ? [oneDark] : []),
      ],
    }),
  });
  pristineText = props.content;
  view.focus();
}

function currentText(): string {
  return view?.state.doc.toString() ?? "";
}

function isDirty(): boolean {
  return view !== null && currentText() !== pristineText;
}

async function requestClose(): Promise<void> {
  if (props.saving) return;
  if (isDirty()) {
    const discard = await confirmDialog({
      title: props.ariaLabel ?? props.title,
      message: t("editor.discardConfirm"),
      confirmText: t("common.confirm"),
      cancelText: t("common.cancel"),
      danger: true,
    });
    if (!discard) return;
  }
  emit("close");
}

// Overlay click never discards a dirty editor; cancel/ESC go through the confirm flow.
function onOverlayClick(): void {
  if (props.saving || isDirty()) return;
  emit("close");
}

function save(): void {
  if (props.saving || props.loading || props.loadError !== null) return;
  emit("save", currentText());
}

const { open, close } = useDialogFocus({
  container: dialogElement,
  initialFocus: () => view?.contentDOM ?? null,
  onEscape: () => void requestClose(),
});

watch(
  () => [props.loading, props.loadError] as const,
  async () => {
    if (props.loading || props.loadError !== null) return;
    await nextTick();
    createEditor();
  },
);

onMounted(() => {
  acquireScrollLock();
  void open();
  if (!props.loading && props.loadError === null) createEditor();
});

onUnmounted(() => {
  view?.destroy();
  view = null;
  close();
  releaseScrollLock();
});
</script>

<style scoped>
.editor-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
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
.editor-dialog-constrained {
  max-width: 720px;
  max-height: 100%;
  margin: auto;
  flex: 0 1 auto;
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
.editor-host-constrained {
  min-height: 320px;
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
  .editor-dialog-constrained {
    max-width: none;
  }
  .editor-hint {
    display: none;
  }
}
</style>
