<template>
  <div>
    <PageHeader :title="t('page.profiles.title')" :desc="t('page.profiles.desc')" />

    <!-- download / import control panel -->
    <div class="dl-panel card" :aria-busy="downloading || updatingAll || importing || profileBusy">
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

    <div v-if="profiles.length === 0" class="card">
      <EmptyState
        icon="layers"
        :title="t('profiles.emptyTitle')"
        :hint="t('profiles.emptyHint')"
      />
    </div>

    <div v-else class="profiles-grid" :aria-busy="profileBusy">
      <article
        v-for="p in profiles"
        :key="p.id"
        class="profile-card"
        :class="{ active: p.id === store.activeProfileId, busy: profileBusy }"
        @click="selectProfile(p)"
      >
        <div
          class="profile-card-main"
          role="button"
          tabindex="0"
          :aria-current="p.id === store.activeProfileId ? 'true' : undefined"
          :aria-disabled="profileBusy || p.id === store.activeProfileId"
          :title="p.id === store.activeProfileId ? undefined : t('profiles.clickToUse')"
          @keydown.enter.prevent="selectProfile(p)"
          @keydown.space.prevent="selectProfile(p)"
        >
          <div class="profile-name-row">
            <span class="profile-name" :title="p.name">{{ p.name }}</span>
            <span v-if="p.id === store.activeProfileId" class="badge badge-accent">
              {{ t('profiles.active') }}
            </span>
          </div>
          <div class="profile-source">
            {{ sourceLabel(p) }} · {{ updatedLabel(p) }}
          </div>
          <div v-if="p.subInfo" class="profile-usage">
            <div class="usage-nums">
              <span class="mono">{{ formatBytes(usedBytes(p)) }} / {{ formatBytes(p.subInfo.total) }}</span>
              <span v-if="p.subInfo.expire" class="mono usage-expire">{{ formatDate(p.subInfo.expire) }}</span>
            </div>
            <div
              class="usage-bar"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="usagePct(p)"
            >
              <div
                class="usage-fill"
                :class="{ 'usage-fill-hot': usagePct(p) >= 90 }"
                :style="{ width: `${usagePct(p)}%` }"
              ></div>
            </div>
          </div>
          <div v-if="p.lastError" class="profile-error" :title="p.lastError" role="status">
            <Icon name="alert" :size="13" />
            <span class="profile-error-text">{{ p.lastError }}</span>
          </div>
        </div>
        <div class="profile-actions" @click.stop>
          <button
            v-if="p.url"
            type="button"
            class="icon-btn"
            :title="t('profiles.update')"
            :aria-label="`${t('profiles.update')}: ${p.name}`"
            :disabled="profileBusy"
            @click="updateOne(p)"
          >
            <Icon name="refresh" :size="14" :class="{ spin: updatingId === p.id }" />
          </button>
          <button
            type="button"
            class="icon-btn danger-hover"
            :title="t('profiles.delete')"
            :aria-label="`${t('profiles.delete')}: ${p.name}`"
            :disabled="profileBusy"
            @click="removeProfile(p)"
          >
            <Icon name="trash" :size="14" />
          </button>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { confirmDialog } from "../components/confirm.js";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import { locale, t } from "../i18n/index.js";
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
import { formatAgo, formatBytes, formatDate } from "../utils/format.js";

const dlUrl = ref("");
const downloading = ref(false);
const updatingAll = ref(false);
const importing = ref(false);
const updatingId = ref("");
const fileInput = ref<HTMLInputElement | null>(null);

const profiles = computed(() => store.profiles);
const hasRemote = computed(() => store.profiles.some((p) => p.url !== ""));
const profileBusy = computed(() => store.operations.profileMutation);

/* ---------- display helpers ---------- */
function sourceLabel(p: ProfileMeta): string {
  if (!p.url) return t("profiles.localFile");
  try {
    return new URL(p.url).hostname || p.url;
  } catch {
    return p.url;
  }
}

function updatedLabel(p: ProfileMeta): string {
  const ms = new Date(p.updatedAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return t("profiles.neverUpdated");
  return formatAgo(p.updatedAt, locale.value);
}

function usedBytes(p: ProfileMeta): number {
  return (p.subInfo?.upload ?? 0) + (p.subInfo?.download ?? 0);
}

function usagePct(p: ProfileMeta): number {
  const total = p.subInfo?.total ?? 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((usedBytes(p) / total) * 100));
}

onMounted(() => {
  void refreshProfiles().catch(() => {});
});

/* ---------- actions ---------- */
async function download(): Promise<void> {
  const url = dlUrl.value.trim();
  if (!url || downloading.value) return;
  downloading.value = true;
  try {
    const res = await addProfile(url);
    dlUrl.value = "";
    if (res.activated) {
      toast.success(t("toast.profileActivated", { name: res.profile.name, n: res.proxyCount ?? 0 }));
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
      toast.error(
        t("toast.profilesUpdateAllPartial", { n: res.updated, f: res.failed.length }),
      );
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
    const res = await activateProfile(p.id);
    toast.success(t("toast.profileActivated", { name: p.name, n: res.proxyCount }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
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
.dl-panel {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 12px;
  margin-bottom: 18px;
}
.dl-input-wrap {
  position: relative;
  min-width: 0;
}
.dl-input {
  width: 100%;
  min-height: 38px;
  padding-right: 42px;
  font-family: var(--font-mono);
  font-size: 12.5px;
}
.dl-paste {
  position: absolute;
  top: 50%;
  right: 4px;
  width: 32px;
  height: 30px;
  transform: translateY(-50%);
}
.dl-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}
.dl-actions .btn {
  min-height: 38px;
  padding-inline: 12px;
}
.hidden-file {
  display: none;
}

.profiles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}
.profile-card {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  padding: 16px 12px 16px 18px;
  overflow: hidden;
  cursor: pointer;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  transition:
    transform 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}
.profile-card::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  content: "";
  background: transparent;
  transition: background 0.15s ease;
}
.profile-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-pop);
  transform: translateY(-1px);
}
.profile-card.active {
  cursor: default;
  border-color: var(--border-accent);
  box-shadow: var(--shadow-card), 0 0 0 3px var(--accent-ring);
}
.profile-card.active::before {
  background: var(--accent);
}
.profile-card.busy {
  cursor: wait;
}
.profile-card-main {
  flex: 1;
  min-width: 0;
  border-radius: var(--radius-sm);
  outline: none;
}
.profile-card-main:focus-visible {
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.profile-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.profile-name {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-source {
  margin-top: 4px;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-usage {
  margin-top: 12px;
}
.usage-nums {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--text-secondary);
  font-size: 11px;
}
.usage-expire {
  color: var(--text-muted);
}
.usage-bar {
  height: 6px;
  margin-top: 6px;
  overflow: hidden;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.usage-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.2s ease;
}
.usage-fill-hot {
  background: var(--danger);
}
.profile-error {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 6px 8px;
  margin-top: 10px;
  color: var(--danger);
  font-size: 11.5px;
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
}
.profile-error-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-actions {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: 5px;
}
.profile-actions .icon-btn {
  width: 34px;
  height: 34px;
}
.danger-hover:hover:not(:disabled) {
  color: var(--danger);
  background: var(--danger-soft);
}
.spin {
  animation: rotate 0.9s linear infinite;
}

@media (max-width: 760px) {
  .dl-panel {
    grid-template-columns: 1fr;
  }
  .dl-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .dl-actions .btn {
    min-width: 0;
  }
  .profiles-grid {
    grid-template-columns: 1fr;
  }
  .profile-card {
    min-height: 112px;
  }
  .profile-actions .icon-btn {
    width: 40px;
    height: 40px;
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
  .profile-card {
    gap: 6px;
    padding: 14px 8px 14px 15px;
  }
  .usage-nums {
    flex-direction: column;
    gap: 2px;
  }
  .profile-actions .icon-btn {
    width: 44px;
    height: 44px;
  }
}
</style>
