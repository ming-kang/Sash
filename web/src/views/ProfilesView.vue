<template>
  <div class="profiles-view">
    <div class="dl-panel" :aria-busy="downloading || updatingAll || importing || profileBusy">
      <div class="dl-input-wrap">
        <input
          v-model="dlUrl"
          type="url"
          class="input dl-input"
          :placeholder="t('profiles.downloadPlaceholder')"
          :aria-label="t('profiles.downloadPlaceholder')"
          :disabled="downloading || profileBusy"
          spellcheck="false"
          @keyup.enter="download"
        />
        <button
          type="button"
          class="icon-btn dl-paste"
          :title="t('profiles.paste')"
          :aria-label="t('profiles.paste')"
          :disabled="downloading || profileBusy"
          @click="pasteFromClipboard"
        >
          <Icon name="clipboard" :size="15" />
        </button>
      </div>
      <div class="dl-actions">
        <button
          type="button"
          class="btn btn-primary dl-action-primary"
          :disabled="downloading || profileBusy || !dlUrl.trim()"
          @click="download"
        >
          <Icon name="download" :size="14" />
          <span>{{ downloading ? t('profiles.downloading') : t('profiles.download') }}</span>
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="updatingAll || profileBusy || !hasRemote"
          @click="updateAll"
        >
          <Icon name="refresh" :size="14" :class="{ spin: updatingAll }" />
          <span>{{ t('profiles.updateAll') }}</span>
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="importing || profileBusy"
          @click="fileInput?.click()"
        >
          <Icon name="upload" :size="14" />
          <span>{{ t('profiles.import') }}</span>
        </button>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept=".yaml,.yml"
        class="hidden-file"
        :aria-label="t('profiles.import')"
        @change="onImportFile"
      />
    </div>

    <div v-if="loadFailed" class="empty-panel" role="alert">
      <EmptyState icon="alert" :title="t('common.loadFailed')" :hint="loadFailed" />
      <div class="empty-retry">
        <button type="button" class="btn btn-secondary btn-sm" @click="loadProfiles">
          {{ t('common.reload') }}
        </button>
      </div>
    </div>

    <div v-else-if="!store.profilesLoaded" class="empty-panel" aria-busy="true">
      <EmptyState icon="loader" :title="t('profiles.loading')" />
    </div>

    <div v-else-if="profiles.length === 0" class="empty-panel">
      <EmptyState
        icon="layers"
        :title="t('profiles.emptyTitle')"
        :hint="t('profiles.emptyHint')"
      />
    </div>

    <p v-if="profiles.length > 1" id="profile-order-hint" class="profile-order-hint">
      {{ chosenId ? t('profiles.reorderDropHint') : t('profiles.reorderHint') }}
    </p>
    <div
      v-if="profiles.length > 0"
      ref="profilesGrid"
      class="profiles-grid"
      :aria-busy="profileBusy"
      @pointerdown.capture="onPointerdown"
      @click.capture="onClick"
      @contextmenu="chosenId && $event.preventDefault()"
    >
      <ProfileCard
        v-for="p in profiles"
        :key="p.id"
        :profile="p"
        :is-active="p.id === store.activeProfileId"
        :is-busy="profileBusy"
        :is-chosen="chosenId === p.id"
        :is-updating="updatingId === p.id"
        :can-reorder="profiles.length > 1"
        @select="selectProfile"
        @update="updateOne"
        @edit="openEditor"
        @rename="renameTarget = $event"
        @remove="removeProfile"
        @move-with-keyboard="moveWithKeyboard"
      />
    </div>

    <ProfileRenameDialog
      v-if="renameTarget"
      :profile="renameTarget"
      @close="renameTarget = null"
    />

    <ProfileEditorDialog
      v-if="editorProfile"
      :profile-id="editorProfile.id"
      :profile-name="editorProfile.name"
      :is-remote="editorProfile.url !== ''"
      @close="editorProfile = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { asyncView } from "../components/async-view.js";
import { confirmDialog } from "../components/confirm.js";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import ProfileRenameDialog from "../components/ProfileRenameDialog.vue";
import ProfileCard from "../components/ProfileCard.vue";
import { useProfileOrder } from "../composables/profile-order.js";
import { t } from "../i18n/index.js";
import {
  activateProfile,
  addProfile,
  deleteProfile,
  errorText,
  importProfile,
  refreshProfiles,
  store,
  toast,
  updateAllProfiles,
  updateProfile,
} from "../stores/index.js";
import type { ProfileMeta } from "../types/index.js";

const ProfileEditorDialog = asyncView(
  () => import("../components/ProfileEditorDialog.vue"),
);

const dlUrl = ref("");
const downloading = ref(false);
const updatingAll = ref(false);
const importing = ref(false);
const updatingId = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const editorProfile = ref<ProfileMeta | null>(null);
const renameTarget = ref<ProfileMeta | null>(null);
const loadFailed = ref("");

const profilesGrid = ref<HTMLElement | null>(null);
const { profiles, chosenId, busy: orderBusy, onPointerdown, onClick, moveWithKeyboard } =
  useProfileOrder(
    profilesGrid,
    computed(() => store.profiles),
    computed(() => store.operations.profileMutation),
  );
const hasRemote = computed(() => store.profiles.some((p) => p.url !== ""));
const profileBusy = computed(() => store.operations.profileMutation || orderBusy.value);

async function loadProfiles(): Promise<void> {
  loadFailed.value = "";
  try {
    await refreshProfiles();
  } catch (error) {
    loadFailed.value = errorText(error);
  }
}

onMounted(() => {
  void loadProfiles();
});

async function download(): Promise<void> {
  const url = dlUrl.value.trim();
  if (!url || downloading.value) return;
  if (!/^https?:\/\/.+/.test(url)) {
    toast.warning(t("profiles.invalidUrl"));
    return;
  }
  downloading.value = true;
  try {
    const res = await addProfile(url);
    dlUrl.value = "";
    if (res.activated) {
      toast.success(
        t("toast.profileActivated", { name: res.profile.name }),
      );
    } else {
      toast.success(t("toast.profileAdded", { name: res.profile.name }));
    }
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    downloading.value = false;
  }
}

async function updateOne(p: ProfileMeta): Promise<void> {
  if (updatingId.value) return;
  updatingId.value = p.id;
  try {
    await updateProfile(p.id);
    toast.success(t("toast.profileUpdated", { name: p.name }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    updatingId.value = "";
  }
}

async function updateAll(): Promise<void> {
  if (updatingAll.value) return;
  updatingAll.value = true;
  try {
    const res = await updateAllProfiles();
    if (res.failed.length === 0) {
      toast.success(t("toast.profilesUpdateAllOk", { n: res.updated }));
    } else {
      toast.warning(t("toast.profilesUpdateAllPartial", { n: res.updated, f: res.failed.length }));
    }
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    updatingAll.value = false;
  }
}

async function selectProfile(p: ProfileMeta): Promise<void> {
  if (profileBusy.value || p.id === store.activeProfileId) return;
  try {
    await activateProfile(p.id);
    toast.success(t("toast.profileActivated", { name: p.name }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

function openEditor(profile: ProfileMeta): void {
  if (profileBusy.value) return;
  editorProfile.value = profile;
}

async function removeProfile(p: ProfileMeta): Promise<void> {
  if (profileBusy.value) return;
  const ok = await confirmDialog({
    title: t("profiles.deleteConfirmTitle"),
    message: t("profiles.deleteConfirmMsg", { name: p.name }),
    confirmText: t("common.confirm"),
    cancelText: t("common.cancel"),
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteProfile(p.id);
    toast.success(t("toast.profileDeleted", { name: p.name }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

function onImportFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || importing.value) return;
  importing.value = true;
  void (async () => {
    try {
      const content = await file.text();
      const name = file.name.replace(/\.(ya?ml)$/i, "") || "imported";
      const res = await importProfile(name, content);
      toast.success(t("toast.profileImported", { name: res.profile.name }));
    } catch (err) {
      toast.error(t("toast.failed", { msg: errorText(err) }));
    } finally {
      importing.value = false;
    }
  })();
}

async function pasteFromClipboard(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) dlUrl.value = text.trim();
  } catch {
    toast.error(t("toast.pasteFailed"));
  }
}
</script>

<style scoped>
.profiles-view {
  min-height: 100%;
}
.dl-panel {
  display: grid;
  min-height: 80px;
  grid-template-columns: minmax(260px, 1fr) auto;
  align-items: center;
  gap: 8px;
  margin-bottom: 15px;
  padding: 12px 34px;
  background: var(--bg-app);
  border-bottom: 1px solid var(--border);
}
.dl-input-wrap {
  position: relative;
  min-width: 0;
}
.dl-input {
  width: 100%;
  min-height: 46px;
  padding-right: 42px;
  font-family: var(--font-mono);
  font-size: 16px;
}
.dl-paste {
  position: absolute;
  top: 50%;
  right: 4px;
  width: 31px;
  height: 30px;
  transform: translateY(-50%);
}
.dl-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}
.dl-actions .btn {
  min-height: 46px;
  padding-inline: 12px;
}
.hidden-file {
  display: none;
}
.empty-panel {
  margin: 0 34px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.empty-retry {
  display: flex;
  justify-content: center;
  padding: 0 20px 18px;
}

.profiles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 10px 12px;
  padding: 0 34px 44px;
}
.profile-order-hint {
  margin: 0 34px 10px;
  color: var(--text-muted);
  font-size: 12px;
}

@media (max-width: 820px) {
  .dl-panel {
    grid-template-columns: 1fr;
    padding-right: 16px;
    padding-left: 16px;
  }
  .profiles-grid {
    padding-right: 16px;
    padding-left: 16px;
  }
  .empty-panel {
    margin-right: 16px;
    margin-left: 16px;
  }
  .profile-order-hint {
    margin-right: 16px;
    margin-left: 16px;
  }
  .dl-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .dl-actions .btn {
    min-width: 0;
  }
}

@media (max-width: 760px) {
  .profiles-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 480px) {
  .dl-panel {
    gap: 8px;
    padding: 10px;
  }
  .dl-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .dl-action-primary {
    grid-column: 1 / -1;
  }
  .dl-actions .btn,
  .dl-input {
    min-height: 44px;
  }
  .dl-paste {
    width: 38px;
    height: 38px;
  }
}
</style>
