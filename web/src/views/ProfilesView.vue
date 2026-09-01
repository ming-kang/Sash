<template>
  <div>
    <PageHeader :title="t('page.profiles.title')" :desc="t('page.profiles.desc')" />

    <!-- download / import bar -->
    <div class="dl-bar card">
      <div class="dl-input-wrap">
        <input
          v-model="dlUrl"
          type="url"
          class="input dl-input"
          :placeholder="t('profiles.downloadPlaceholder')"
          :disabled="downloading"
          spellcheck="false"
          @keyup.enter="download"
        />
        <button class="icon-btn dl-paste" :title="t('profiles.paste')" @click="pasteFromClipboard">
          <Icon name="clipboard" :size="14" />
        </button>
      </div>
      <button class="btn btn-primary" :disabled="downloading || !dlUrl.trim()" @click="download">
        <Icon name="download" :size="13" />
        <span>{{ downloading ? t('profiles.downloading') : t('profiles.download') }}</span>
      </button>
      <button
        class="btn btn-secondary"
        :disabled="updatingAll || !hasRemote"
        @click="updateAll"
      >
        <Icon name="refresh" :size="13" :class="{ spin: updatingAll }" />
        <span>{{ t('profiles.updateAll') }}</span>
      </button>
      <button class="btn btn-secondary" :disabled="importing" @click="fileInput?.click()">
        <Icon name="upload" :size="13" />
        <span>{{ t('profiles.import') }}</span>
      </button>
      <input
        ref="fileInput"
        type="file"
        accept=".yaml,.yml"
        class="hidden-file"
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

    <div v-else class="profiles-grid">
      <div
        v-for="p in profiles"
        :key="p.id"
        class="profile-card"
        :class="{ active: p.id === store.activeProfileId }"
        :title="p.id === store.activeProfileId ? '' : t('profiles.clickToUse')"
        @click="selectProfile(p)"
      >
        <div class="profile-body">
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
            <div class="usage-bar">
              <div
                class="usage-fill"
                :class="{ 'usage-fill-hot': usagePct(p) >= 90 }"
                :style="{ width: `${usagePct(p)}%` }"
              ></div>
            </div>
          </div>
          <div v-if="p.lastError" class="profile-error" :title="p.lastError">
            <Icon name="alert" :size="12" />
            <span class="profile-error-text">{{ p.lastError }}</span>
          </div>
        </div>
        <div class="profile-actions" @click.stop>
          <button
            v-if="p.url"
            class="icon-btn"
            :class="{ spin: updatingId === p.id }"
            :title="t('profiles.update')"
            :disabled="Boolean(updatingId)"
            @click="updateOne(p)"
          >
            <Icon name="refresh" :size="13" />
          </button>
          <button
            class="icon-btn danger-hover"
            :title="t('profiles.delete')"
            @click="removeProfile(p)"
          >
            <Icon name="trash" :size="13" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api/index.js";
import { confirmDialog } from "../components/confirm.js";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import { locale, t } from "../i18n/index.js";
import {
  errorText,
  refreshProfiles,
  refreshRuntimeState,
  store,
  toast,
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
    const res = await api.addProfile(url);
    await refreshProfiles();
    dlUrl.value = "";
    if (res.activated) {
      await refreshRuntimeState();
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
    const res = await api.updateProfile(p.id);
    await refreshProfiles();
    if (res.proxyCount !== undefined) await refreshRuntimeState();
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
    const res = await api.updateAllProfiles();
    await refreshProfiles();
    if (res.proxyCount !== undefined) await refreshRuntimeState();
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
  if (p.id === store.activeProfileId) return;
  try {
    const res = await api.setActiveProfile(p.id);
    await refreshProfiles();
    await refreshRuntimeState();
    toast.success(t("toast.profileActivated", { name: p.name, n: res.proxyCount }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

async function removeProfile(p: ProfileMeta): Promise<void> {
  const ok = await confirmDialog({
    title: t("profiles.deleteConfirmTitle"),
    message: t("profiles.deleteConfirmMsg", { name: p.name }),
    confirmText: t("common.confirm"),
    cancelText: t("common.cancel"),
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api.deleteProfile(p.id);
    await refreshProfiles();
    if (res.wasActive) await refreshRuntimeState();
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
      const res = await api.importProfile(name, content);
      await refreshProfiles();
      if (res.activated) await refreshRuntimeState();
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
.dl-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  margin-bottom: 16px;
}
.dl-input-wrap {
  flex: 1;
  position: relative;
  min-width: 0;
}
.dl-input {
  width: 100%;
  font-family: var(--font-mono);
  font-size: 12.5px;
  padding-right: 34px;
}
.dl-paste {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
}
.hidden-file {
  display: none;
}

.profiles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}
.profile-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px 14px 14px 16px;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease;
}
.profile-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-card);
}
.profile-card.active {
  border-color: var(--border-accent);
  box-shadow: inset 3px 0 0 var(--accent);
  cursor: default;
}
.profile-body {
  flex: 1;
  min-width: 0;
}
.profile-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.profile-name {
  font-size: 14px;
  font-weight: 650;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-source {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-usage {
  margin-top: 8px;
}
.usage-nums {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  color: var(--text-secondary);
}
.usage-expire {
  color: var(--text-muted);
}
.usage-bar {
  margin-top: 4px;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-inset);
  overflow: hidden;
}
.usage-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.2s ease;
}
.usage-fill-hot {
  background: var(--danger);
}
.profile-error {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--danger);
}
.profile-error-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}
.danger-hover:hover {
  color: var(--danger);
}
.spin {
  animation: rotate 0.9s linear infinite;
}

@media (max-width: 760px) {
  .dl-bar {
    flex-wrap: wrap;
  }
  .dl-input-wrap {
    flex-basis: 100%;
  }
  .profiles-grid {
    grid-template-columns: 1fr;
  }
}
</style>
