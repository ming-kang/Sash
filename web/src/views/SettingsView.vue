<template>
  <div>
    <PageHeader :title="t('page.settings.title')" :desc="t('page.settings.desc')" />

    <div class="settings-grid">
      <!-- Interface -->
      <UiCard
        :title="t('settings.appearanceTitle')"
        :desc="t('settings.appearanceDesc')"
        class="settings-card"
      >
        <div
          class="segmented preference-control"
          role="group"
          :aria-label="t('settings.appearanceTitle')"
        >
          <button
            type="button"
            class="segmented-item"
            :class="{ active: theme === 'system' }"
            :aria-pressed="theme === 'system'"
            @click="switchTheme('system')"
          >
            {{ t('theme.system') }}
          </button>
          <button
            type="button"
            class="segmented-item"
            :class="{ active: theme === 'light' }"
            :aria-pressed="theme === 'light'"
            @click="switchTheme('light')"
          >
            {{ t('theme.light') }}
          </button>
          <button
            type="button"
            class="segmented-item"
            :class="{ active: theme === 'dark' }"
            :aria-pressed="theme === 'dark'"
            @click="switchTheme('dark')"
          >
            {{ t('theme.dark') }}
          </button>
        </div>
      </UiCard>

      <UiCard :title="t('settings.langTitle')" :desc="t('settings.langDesc')" class="settings-card">
        <div class="segmented preference-control" role="group" :aria-label="t('settings.langTitle')">
          <button
            type="button"
            class="segmented-item"
            :class="{ active: locale === 'zh' }"
            :aria-pressed="locale === 'zh'"
            @click="switchLocale('zh')"
          >
            中文
          </button>
          <button
            type="button"
            class="segmented-item"
            :class="{ active: locale === 'en' }"
            :aria-pressed="locale === 'en'"
            @click="switchLocale('en')"
          >
            English
          </button>
        </div>
      </UiCard>

      <!-- Network -->
      <UiCard :title="t('settings.networkTitle')" class="settings-card">
        <div class="setting-row interrupt-row">
          <div class="setting-info">
            <label class="setting-name" for="mixed-port">{{ t('settings.mixedPortTitle') }}</label>
            <span class="setting-desc">{{ t('settings.mixedPortDesc') }}</span>
          </div>
          <div class="setting-action port-action">
            <input
              id="mixed-port"
              v-model.number="mixedPort"
              type="number"
              min="1"
              max="65535"
              class="input input-sm port-input"
              :aria-label="t('settings.mixedPortTitle')"
              :disabled="savingPort"
            />
            <button
              v-if="portDirty"
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="savingPort"
              @click="resetMixedPort"
            >
              {{ t('common.reset') }}
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm interrupt-save"
              :disabled="savingPort || !portValid"
              @click="saveMixedPort"
            >
              {{ savingPort ? t('common.loading') : t('common.save') }}
            </button>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-name">{{ t('settings.allowLanTitle') }}</span>
            <span class="setting-desc">{{ t('settings.allowLanDesc') }}</span>
          </div>
          <div class="setting-action">
            <UiSwitch
              :model-value="store.status?.settings.allowLan ?? false"
              :label="t('settings.allowLanTitle')"
              :disabled="store.operations.networkSetting"
              @update:model-value="toggleAllowLan"
            />
          </div>
        </div>

        <div class="setting-row caution-row">
          <div class="setting-info">
            <span class="setting-name">{{ t('settings.tunTitle') }}</span>
            <span class="setting-desc">{{ tunDescription }}</span>
          </div>
          <div class="setting-action">
            <span
              v-if="tunStatusBadge"
              class="badge"
              :class="tunStatusBadge.className"
              :title="tunStatusBadge.title"
            >
              {{ tunStatusBadge.text }}
            </span>
            <UiSwitch
              :model-value="store.status?.settings.tun ?? false"
              :label="t('settings.tunTitle')"
              :disabled="store.operations.networkSetting"
              @update:model-value="toggleTun"
            />
          </div>
        </div>
      </UiCard>

      <!-- Core control -->
      <UiCard :title="t('settings.coreTitle')" class="settings-card">
        <div class="setting-row danger-row">
          <div class="setting-info">
            <span class="setting-name">{{ t('settings.restartTitle') }}</span>
            <span class="setting-desc">{{ t('settings.restartDesc') }}</span>
          </div>
          <div class="setting-action">
            <button
              type="button"
              class="btn btn-sm danger-action"
              :disabled="restarting"
              @click="restartCore"
            >
              <Icon name="power" :size="13" :class="{ spin: restarting }" />
              <span>{{ t('settings.restartBtn') }}</span>
            </button>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-name">{{ t('settings.reloadTitle') }}</span>
            <span class="setting-desc">{{ t('settings.reloadDesc') }}</span>
          </div>
          <div class="setting-action">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="reloading"
              @click="reloadConfig"
            >
              <Icon name="refresh" :size="13" :class="{ spin: reloading }" />
              <span>{{ t('settings.reloadBtn') }}</span>
            </button>
          </div>
        </div>
      </UiCard>

      <!-- Runtime info -->
      <UiCard :title="t('settings.aboutTitle')" class="settings-card runtime-card">
        <dl class="info-grid">
          <div class="info-item">
            <dt>{{ t('overview.daemonPort') }}</dt>
            <dd class="mono">127.0.0.1:{{ store.status?.settings.daemonPort ?? 19090 }}</dd>
          </div>
          <div class="info-item">
            <dt>{{ t('overview.controller') }}</dt>
            <dd class="mono">{{ store.status?.settings.controller || '-' }}</dd>
          </div>
          <div class="info-item">
            <dt>{{ t('settings.coreVersion') }}</dt>
            <dd class="mono">{{ coreVersion || '-' }}</dd>
          </div>
        </dl>
      </UiCard>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api/index.js";
import { confirmDialog } from "../components/confirm.js";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import UiCard from "../components/UiCard.vue";
import UiSwitch from "../components/UiSwitch.vue";
import { locale, setLocale, t, type Locale } from "../i18n/index.js";
import {
  errorText,
  patchBooleanSetting,
  refreshRuntimeState,
  store,
  toast,
  tunRuntime,
} from "../stores/index.js";
import {
  isCommittedDraftDirty,
  reconcileCommittedDraft,
} from "../stores/state-ownership.js";
import { setTheme, theme, type Theme } from "../theme.js";

const committedMixedPort = ref(store.status?.settings.mixedPort ?? 17890);
const mixedPort = ref(committedMixedPort.value);

const savingPort = ref(false);
const restarting = ref(false);
const reloading = ref(false);

watch(
  () => store.status?.settings.mixedPort,
  (next) => {
    if (next === undefined) return;
    const previous = committedMixedPort.value;
    committedMixedPort.value = next;
    mixedPort.value = reconcileCommittedDraft(
      mixedPort.value,
      previous,
      next,
      savingPort.value,
    );
  },
);

const portDirty = computed(() =>
  isCommittedDraftDirty(mixedPort.value, committedMixedPort.value),
);
const portValid = computed(
  () =>
    Number.isInteger(mixedPort.value) &&
    mixedPort.value >= 1 &&
    mixedPort.value <= 65535 &&
    portDirty.value,
);

const coreVersion = computed(() => {
  const version = store.status?.core.version;
  return version ? (version.startsWith("v") ? version : `v${version}`) : "";
});
const tunStatusBadge = computed(() => {
  switch (tunRuntime.value) {
    case "active":
      return {
        text: t("settings.tunStateActive"),
        title: t("settings.tunDesc"),
        className: "badge-success",
      };
    case "inactive":
      return {
        text: t("settings.tunStateInactive"),
        title: t("settings.tunInactiveDesc"),
        className: "badge-warning",
      };
    case "unverified":
      return {
        text: t("settings.tunStateUnverified"),
        title: t("settings.tunUnverifiedDesc"),
        className: "badge-warning",
      };
    case "stopped":
      return {
        text: t("settings.tunStateStopped"),
        title: t("settings.tunDesc"),
        className: "badge-neutral",
      };
    case "unexpected-active":
      return {
        text: t("settings.tunStateUnexpected"),
        title: t("settings.tunUnexpectedDesc"),
        className: "badge-warning",
      };
    default:
      return null;
  }
});
const tunDescription = computed(() => {
  switch (tunRuntime.value) {
    case "inactive":
      return t("settings.tunInactiveDesc");
    case "unverified":
      return t("settings.tunUnverifiedDesc");
    case "unexpected-active":
      return t("settings.tunUnexpectedDesc");
    default:
      return t("settings.tunDesc");
  }
});

function switchTheme(next: Theme): void {
  if (next !== theme.value) setTheme(next);
}

function switchLocale(next: Locale): void {
  if (next === locale.value) return;
  setLocale(next);
  toast.success(t("toast.langSwitched"));
}

function resetMixedPort(): void {
  mixedPort.value = committedMixedPort.value;
}

async function saveMixedPort(): Promise<void> {
  if (!portValid.value || savingPort.value) return;
  savingPort.value = true;
  try {
    const result = await api.patchSetting("mixed-port", String(mixedPort.value));
    if (store.status) store.status = { ...store.status, settings: result.settings };
    await refreshRuntimeState();
    toast.success(t("toast.portSaved"));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    savingPort.value = false;
  }
}

async function applyToggle(key: "allow-lan" | "tun", next: boolean): Promise<void> {
  try {
    await patchBooleanSetting(key, next);
    toast.success(t("toast.settingSaved"));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  }
}

function toggleAllowLan(next: boolean): void {
  void applyToggle("allow-lan", next);
}

function toggleTun(next: boolean): void {
  void applyToggle("tun", next);
}

async function restartCore(): Promise<void> {
  const ok = await confirmDialog({
    title: t("settings.restartConfirmTitle"),
    message: t("settings.restartConfirmMsg"),
    confirmText: t("common.confirm"),
    cancelText: t("common.cancel"),
    danger: true,
  });
  if (!ok || restarting.value) return;
  restarting.value = true;
  try {
    await api.restartCore();
    await refreshRuntimeState();
    toast.success(t("toast.coreRestarted"));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    restarting.value = false;
  }
}

async function reloadConfig(): Promise<void> {
  if (reloading.value) return;
  reloading.value = true;
  try {
    const res = await api.reloadCoreConfig();
    await refreshRuntimeState();
    toast.success(t("toast.configReloaded", { n: res.proxyCount }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    reloading.value = false;
  }
}
</script>

<style scoped>
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: stretch;
  gap: 16px;
}
.settings-card {
  min-width: 0;
}
.runtime-card {
  grid-column: 1 / -1;
}
.preference-control {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: 100%;
}
.preference-control .segmented-item {
  min-height: 34px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 68px;
  padding: 13px 10px;
  border-bottom: 1px solid var(--border);
}
.setting-row:first-child {
  margin-top: -2px;
}
.setting-row:last-child {
  border-bottom: none;
}
.interrupt-row,
.caution-row {
  background: var(--warning-soft);
  box-shadow: inset 3px 0 0 var(--warning);
}
.danger-row {
  background: var(--danger-soft);
  box-shadow: inset 3px 0 0 var(--danger);
}
.setting-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.setting-name {
  color: var(--text-primary);
  font-size: 13.5px;
  font-weight: 600;
}
.setting-desc {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}
.setting-action {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 8px;
}
.port-input {
  width: 96px;
  font-family: var(--font-mono);
  text-align: right;
}
.interrupt-save {
  color: var(--warning);
  background: var(--warning-soft);
  border-color: var(--warning);
}
.danger-action {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: var(--danger);
}
.interrupt-save:hover:not(:disabled),
.danger-action:hover:not(:disabled) {
  box-shadow: 0 0 0 3px var(--accent-ring);
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 24px;
}
.info-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.info-item dt {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 12.5px;
}
.info-item dd {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 12.5px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 760px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
  .runtime-card {
    grid-column: auto;
  }
  .info-grid {
    grid-template-columns: 1fr;
  }
  .preference-control .segmented-item,
  .setting-action .btn {
    min-height: 40px;
  }
}

@media (max-width: 480px) {
  .settings-grid {
    gap: 12px;
  }
  .preference-control {
    grid-template-columns: 1fr;
  }
  .preference-control .segmented-item {
    min-height: 44px;
  }
  .setting-row {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    padding: 14px 10px;
  }
  .setting-action {
    align-self: stretch;
    justify-content: flex-end;
  }
  .port-action {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
  }
  .port-input {
    width: 100%;
    min-height: 44px;
    text-align: left;
  }
  .setting-action .btn {
    min-height: 44px;
  }
  .info-item {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }
  .info-item dd {
    width: 100%;
  }
}
</style>
