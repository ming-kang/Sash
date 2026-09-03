<template>
  <div>
    <PageHeader :title="t('page.settings.title')" :desc="t('page.settings.desc')">
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        @click="fileEditorOpen = true"
      >
        <Icon name="code" :size="14" />
        {{ t('settings.editFile') }}
      </button>
    </PageHeader>

    <SettingsFileDialog v-if="fileEditorOpen" @close="fileEditorOpen = false" />

    <div class="settings-grid">
      <!-- Interface -->
      <UiCard :title="t('settings.appearanceTitle')" class="settings-card">
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-name">{{ t('settings.themeTitle') }}</span>
            <span class="setting-desc">{{ t('settings.appearanceDesc') }}</span>
          </div>
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
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-name">{{ t('settings.langTitle') }}</span>
            <span class="setting-desc">{{ t('settings.langDesc') }}</span>
          </div>
          <div class="segmented preference-control language-control" role="group" :aria-label="t('settings.langTitle')">
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
              :disabled="savingPort || !store.status"
            />
            <button
              v-if="portDirty"
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="savingPort || !store.status"
              @click="resetMixedPort"
            >
              {{ t('common.reset') }}
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm interrupt-save"
              :disabled="savingPort || !portValid || !store.status"
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
              :disabled="store.operations.networkSetting || !store.status"
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
              :disabled="store.operations.networkSetting || !store.status"
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
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import SettingsFileDialog from "../components/SettingsFileDialog.vue";
import UiCard from "../components/UiCard.vue";
import UiSwitch from "../components/UiSwitch.vue";
import { coreVersion, tunStatusBadge, useCoreRestart } from "../composables/core-runtime.js";
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

const fileEditorOpen = ref(false);

const committedMixedPort = ref(store.status?.settings.mixedPort ?? 17890);
const mixedPort = ref(committedMixedPort.value);

const savingPort = ref(false);
const { restarting, restartCore } = useCoreRestart();
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
  width: min(1046px, 100%);
  grid-template-columns: 1fr;
  gap: 12px;
  margin: 0 auto;
}
.settings-card {
  min-width: 0;
}
.preference-control {
  display: grid;
  width: min(360px, 48%);
  grid-template-columns: repeat(3, minmax(0, 1fr));
  flex-shrink: 0;
  gap: 0;
}
.language-control {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.preference-control .segmented-item {
  min-height: 27px;
  border: 0;
  border-radius: 0;
  font-size: 14px;
}
.preference-control .segmented-item:first-child {
  border-radius: 5px 0 0 5px;
}
.preference-control .segmented-item:last-child {
  border-radius: 0 5px 5px 0;
}

.setting-row {
  display: flex;
  min-height: 43px;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 6px 5px;
  border-bottom: 0;
  transition: background var(--motion-fast) var(--ease-standard);
}
.setting-row:first-child {
  margin-top: -2px;
}
.setting-row:last-child {
  border-bottom: 0;
}
.setting-row:hover {
  background: var(--general-row-hover);
  border-radius: 3px;
}
.caution-row .setting-name {
  color: var(--warning);
}
.danger-row .setting-name {
  color: var(--danger);
}
.setting-info {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.setting-name {
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 400;
}
.setting-desc {
  max-width: 630px;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.35;
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
  appearance: textfield;
  -moz-appearance: textfield;
}
.port-input::-webkit-outer-spin-button,
.port-input::-webkit-inner-spin-button {
  margin: 0;
  -webkit-appearance: none;
}
.interrupt-save {
  color: var(--warning);
  background: transparent;
  border-color: var(--warning-border);
}
.danger-action {
  color: var(--danger);
  background: transparent;
  border-color: var(--danger-border);
}
.interrupt-save:hover:not(:disabled) {
  background: var(--warning-soft);
}
.danger-action:hover:not(:disabled) {
  background: var(--danger-soft);
}

.info-grid {
  display: grid;
  grid-template-columns: 1fr;
}
.info-item {
  display: flex;
  min-width: 0;
  min-height: 39px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 5px;
  border-bottom: 0;
}
.info-item:last-child {
  border-bottom: 0;
}
.info-item dt {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: 16px;
}
.info-item dd {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 760px) {
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
    width: 100%;
  }
  .preference-control .segmented-item {
    min-height: 40px;
    font-size: 14px;
  }
  .setting-row {
    min-height: 0;
    align-items: stretch;
    flex-direction: column;
    gap: 11px;
    padding: 13px 8px;
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
    min-height: 0;
    align-items: flex-start;
    flex-direction: column;
    gap: 3px;
    padding: 10px 8px;
  }
  .info-item dd {
    width: 100%;
  }
}
</style>
