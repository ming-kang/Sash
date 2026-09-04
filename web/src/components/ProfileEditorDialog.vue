<template>
  <CodeEditorModal
    :title="profileName"
    :aria-label="t('editor.title')"
    :hint="isRemote ? t('editor.remoteWarning') : undefined"
    :content="content"
    language="yaml"
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
import { errorText, toast, writeProfileContent } from "../stores/index.js";
import CodeEditorModal from "./CodeEditorModal.vue";

const props = defineProps<{
  profileId: string;
  profileName: string;
  isRemote: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const content = ref("");
const loading = ref(true);
const saving = ref(false);
const loadError = ref<string | null>(null);

onMounted(async () => {
  try {
    const result = await api.getProfileContent(props.profileId);
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
    await writeProfileContent(props.profileId, text);
    toast.success(t("toast.profileSaved", { name: props.profileName }));
    emit("close");
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    saving.value = false;
  }
}
</script>
