<template>
  <CodeEditorModal
    :title="t('settings.fileTitle')"
    :hint="t('settings.fileHint')"
    :content="content"
    language="json"
    layout="constrained"
    :loading="loading"
    :load-error="loadError"
    :saving="saving"
    @save="save"
    @close="emit('close')"
  />
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../api/index.js";
import { t } from "../i18n/index.js";
import { errorText, refreshStatus, toast } from "../stores/index.js";
import CodeEditorModal from "./CodeEditorModal.vue";

const emit = defineEmits<{ close: [] }>();

const content = ref("");
const loading = ref(true);
const saving = ref(false);
const loadError = ref<string | null>(null);

onMounted(async () => {
  try {
    const result = await api.getSettingsFile();
    content.value = result.content;
  } catch (error) {
    loadError.value = errorText(error);
  } finally {
    loading.value = false;
  }
});

async function save(text: string): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    const result = await api.saveSettingsFile(text);
    await refreshStatus();
    if (result.restartRequired) {
      toast.success(t("toast.settingsSavedRestart"));
    } else {
      toast.success(t("toast.settingSaved"));
    }
    emit("close");
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    saving.value = false;
  }
}
</script>
