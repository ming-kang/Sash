<template>
  <article
    :data-id="profile.id"
    class="profile-card"
    :class="{
      active: isActive,
      busy: isBusy,
      'profile-chosen': isChosen,
    }"
  >
    <div
      class="profile-card-main"
      role="button"
      tabindex="0"
      :aria-current="isActive ? 'true' : undefined"
      :aria-disabled="isBusy || isActive"
      :aria-describedby="canReorder ? 'profile-order-hint' : undefined"
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      :title="isActive ? undefined : t('profiles.clickToUse')"
      @click="emit('select', profile)"
      @keydown.enter.prevent="emit('select', profile)"
      @keydown.space.prevent="emit('select', profile)"
      @keydown="emit('moveWithKeyboard', $event, profile.id)"
    >
      <div class="profile-name-row">
        <span class="profile-name" :title="profile.name">{{ profile.name }}</span>
      </div>
      <div class="profile-source" :title="`${sourceLabel} · ${updatedLabel}`">
        {{ sourceLabel }} · {{ updatedLabel }}
      </div>
      <div v-if="profile.subInfo" class="profile-usage">
        <div class="usage-nums">
          <span class="mono">{{ formatBytes(usedBytes) }} / {{ formatBytes(profile.subInfo.total) }}</span>
          <span v-if="profile.subInfo.expire" class="mono usage-expire">{{ formatDate(profile.subInfo.expire) }}</span>
        </div>
        <div
          class="usage-bar"
          role="progressbar"
          :aria-label="t('profiles.usageLabel')"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="usagePct"
        >
          <div
            class="usage-fill"
            :class="{ 'usage-fill-hot': usagePct >= 90 }"
            :style="{ width: `${usagePct}%` }"
          ></div>
        </div>
      </div>
      <div v-if="profile.lastError" class="profile-error" :title="profile.lastError" role="status">
        <Icon name="alert" :size="13" />
        <span class="profile-error-text">{{ profile.lastError }}</span>
      </div>
    </div>
    <div class="profile-actions">
      <button
        type="button"
        class="icon-btn"
        :title="t('profiles.rename')"
        :aria-label="`${t('profiles.rename')}: ${profile.name}`"
        :disabled="isBusy"
        @click.stop="emit('rename', profile)"
      >
        <Icon name="pencil" :size="14" />
      </button>
      <button
        type="button"
        class="icon-btn"
        :title="t('profiles.edit')"
        :aria-label="`${t('profiles.edit')}: ${profile.name}`"
        :disabled="isBusy"
        @click.stop="emit('edit', profile)"
      >
        <Icon name="code" :size="14" />
      </button>
      <button
        v-if="profile.url"
        type="button"
        class="icon-btn"
        :title="t('profiles.update')"
        :aria-label="`${t('profiles.update')}: ${profile.name}`"
        :disabled="isBusy || isUpdating"
        @click.stop="emit('update', profile)"
      >
        <Icon name="refresh" :size="14" :class="{ spin: isUpdating }" />
      </button>
      <button
        type="button"
        class="icon-btn danger-hover"
        :title="t('profiles.delete')"
        :aria-label="`${t('profiles.delete')}: ${profile.name}`"
        :disabled="isBusy"
        @click.stop="emit('remove', profile)"
      >
        <Icon name="trash" :size="14" />
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import { t } from "../i18n/index.js";
import type { ProfileMeta } from "../types/index.js";
import { formatAgo, formatBytes, formatDate } from "../utils/format.js";

const props = defineProps<{
  profile: ProfileMeta;
  isActive: boolean;
  isBusy: boolean;
  isChosen: boolean;
  isUpdating: boolean;
  canReorder: boolean;
}>();

const emit = defineEmits<{
  select: [profile: ProfileMeta];
  update: [profile: ProfileMeta];
  edit: [profile: ProfileMeta];
  rename: [profile: ProfileMeta];
  remove: [profile: ProfileMeta];
  moveWithKeyboard: [event: KeyboardEvent, id: string];
}>();

const sourceLabel = computed(() => {
  const p = props.profile;
  if (!p.url) return t("profiles.localFile");
  try {
    return new URL(p.url).hostname || p.url;
  } catch {
    return p.url;
  }
});

const updatedLabel = computed(() => {
  const p = props.profile;
  const ms = new Date(p.updatedAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return t("profiles.neverUpdated");
  return formatAgo(p.updatedAt);
});

const usedBytes = computed(() => {
  const p = props.profile;
  return (p.subInfo?.upload ?? 0) + (p.subInfo?.download ?? 0);
});

const usagePct = computed(() => {
  const total = props.profile.subInfo?.total ?? 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((usedBytes.value / total) * 100));
});
</script>

<style scoped>
.profile-card {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 72px;
  overflow: hidden;
  cursor: pointer;
  background: var(--bg-panel);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  transition:
    background var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard);
}
.profile-card::before {
  position: absolute;
  inset: 2px auto 2px 0;
  width: 4px;
  border-radius: 0 var(--radius-full) var(--radius-full) 0;
  content: "";
  background: var(--border-strong);
  pointer-events: none;
}
.profile-card:hover {
  background: var(--bg-hover);
  border-color: var(--border);
}
.profile-card.active {
  cursor: default;
  background: var(--bg-panel);
  border-color: transparent;
}
.profile-card.active::before {
  background: var(--selection);
}
.profile-card.busy {
  cursor: wait;
}
.profile-card-main {
  flex: 1;
  min-width: 0;
  padding: 10px 8px 10px 15px;
  border-radius: var(--radius-sm);
  outline: none;
  user-select: none;
  -webkit-touch-callout: none;
}
.profile-card-main:focus-visible {
  box-shadow: inset 0 0 0 3px var(--accent-ring);
}
.profile-card.profile-chosen {
  border-color: var(--accent);
  cursor: grabbing;
}
.profile-card.profile-placeholder {
  opacity: 0.35;
}
.profile-card.profile-drag-ghost {
  box-shadow: var(--shadow-pop);
  opacity: 0.95 !important;
  pointer-events: none;
  cursor: grabbing;
}
.profile-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-right: 140px;
}
.profile-name {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-source {
  margin-top: 4px;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-usage {
  margin-top: 7px;
}
.usage-nums {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--text-secondary);
  font-size: 14px;
}
.usage-expire {
  color: var(--text-muted);
}
.usage-bar {
  height: 4px;
  margin-top: 6px;
  overflow: hidden;
  background: var(--border);
  border-radius: var(--radius-full);
}
.usage-fill {
  height: 100%;
  background: var(--selection);
  border-radius: var(--radius-full);
  transition: width var(--motion-normal) var(--ease-standard);
}
.usage-fill-hot {
  background: var(--danger);
}
.profile-error {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-top: 10px;
  color: var(--danger);
  font-size: 14px;
}
.profile-error-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  flex-shrink: 0;
  gap: 3px;
}
.profile-actions .icon-btn {
  width: 31px;
  height: 31px;
}
.danger-hover:hover:not(:disabled) {
  color: var(--danger);
  background: var(--danger-soft);
}
.spin {
  animation: rotate 0.9s linear infinite;
}

@media (max-width: 760px) {
  .profile-name-row {
    margin-right: 172px;
  }
  .profile-actions .icon-btn {
    width: 40px;
    height: 40px;
  }
}

@media (max-width: 480px) {
  .profile-card-main {
    padding: 14px 8px 14px 15px;
  }
  .profile-name-row {
    margin-right: 164px;
  }
  .usage-nums {
    flex-direction: column;
    gap: 2px;
  }
  .profile-actions .icon-btn {
    width: 38px;
    height: 38px;
  }
}
</style>
