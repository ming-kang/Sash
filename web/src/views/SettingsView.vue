<template>
  <div>
    <PageHeader :title="t('page.settings.title')" :desc="t('page.settings.desc')" />

    <!-- Interface -->
    <UiCard :title="t('settings.langTitle')" :desc="t('settings.langDesc')">
      <div class="segmented">
        <button
          class="segmented-item"
          :class="{ active: locale === 'zh' }"
          @click="switchLocale('zh')"
        >
          中文
        </button>
        <button
          class="segmented-item"
          :class="{ active: locale === 'en' }"
          @click="switchLocale('en')"
        >
          English
        </button>
      </div>
    </UiCard>

    <!-- Network -->
    <UiCard :title="t('settings.networkTitle')" class="mt-4">
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-name">{{ t('settings.mixedPortTitle') }}</span>
          <span class="setting-desc">{{ t('settings.mixedPortDesc') }}</span>
        </div>
        <div class="setting-action">
          <input
            v-model.number="mixedPort"
            type="number"
            min="1"
            max="65535"
            class="input input-sm port-input"
            :disabled="savingPort"
            @input="portDirty = true"
          />
          <button
            class="btn btn-secondary btn-sm"
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
          <UiSwitch :model-value="allowLan" :disabled="toggling" @update:model-value="toggleAllowLan" />
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-name">{{ t('settings.tunTitle') }}</span>
          <span class="setting-desc">{{ t('settings.tunDesc') }}</span>
        </div>
        <div class="setting-action">
          <UiSwitch :model-value="tunMode" :disabled="toggling" @update:model-value="toggleTun" />
        </div>
      </div>
    </UiCard>

    <!-- Core control -->
    <UiCard :title="t('settings.coreTitle')" class="mt-4">
      <div class="setting-row">
        <div class="setting-info">
          <span class="setting-name">{{ t('settings.restartTitle') }}</span>
          <span class="setting-desc">{{ t('settings.restartDesc') }}</span>
        </div>
        <div class="setting-action">
          <button class="btn btn-secondary btn-sm" :disabled="restarting" @click="restartCore">
            <Icon name="power" :size="12" :class="{ spin: restarting }" />
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
          <button class="btn btn-secondary btn-sm" :disabled="reloading" @click="reloadConfig">
            <Icon name="refresh" :size="12" :class="{ spin: reloading }" />
            <span>{{ t('settings.reloadBtn') }}</span>
          </button>
        </div>
      </div>
    </UiCard>

    <!-- Runtime info -->
    <UiCard :title="t('settings.aboutTitle')" class="mt-4">
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
        <div class="info-item">
          <dt>{{ t('settings.uiVersion') }}</dt>
          <dd class="mono">{{ store.status?.settings.uiVersion || '-' }}</dd>
        </div>
      </dl>
    </UiCard>
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
  refreshRuntimeState,
  refreshStatus,
  store,
  toast,
} from "../stores/index.js";

const mixedPort = ref(store.status?.settings.mixedPort ?? 17890);
const allowLan = ref(store.status?.settings.allowLan ?? false);
const tunMode = ref(store.status?.settings.tun ?? false);

const savingPort = ref(false);
const portDirty = ref(false);
const toggling = ref(false);
const restarting = ref(false);
const reloading = ref(false);

watch(
  () => store.status?.settings,
  (s) => {
    if (!s) return;
    if (!portDirty.value && !savingPort.value) mixedPort.value = s.mixedPort;
    if (!toggling.value) {
      allowLan.value = s.allowLan;
      tunMode.value = s.tun;
    }
  },
);

const portValid = computed(
  () =>
    Number.isInteger(mixedPort.value) &&
    mixedPort.value >= 1 &&
    mixedPort.value <= 65535 &&
    mixedPort.value !== store.status?.settings.mixedPort,
);

const coreVersion = computed(() => {
  const v = store.status?.core.version ?? store.status?.settings.coreVersion;
  return v ? (v.startsWith("v") ? v : `v${v}`) : "";
});

function switchLocale(next: Locale): void {
  if (next === locale.value) return;
  setLocale(next);
  toast.success(t("toast.langSwitched"));
}

async function saveMixedPort(): Promise<void> {
  if (!portValid.value || savingPort.value) return;
  savingPort.value = true;
  try {
    await api.patchSetting("mixed-port", String(mixedPort.value));
    await refreshStatus();
    portDirty.value = false;
    toast.success(t("toast.portSaved"));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    savingPort.value = false;
  }
}

async function applyToggle(key: "allow-lan" | "tun", next: boolean): Promise<void> {
  toggling.value = true;
  try {
    await api.patchSetting(key, next ? "on" : "off");
    await refreshStatus();
    toast.success(t("toast.settingSaved"));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    toggling.value = false;
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
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 13px 0;
  border-bottom: 1px solid var(--border);
}
.setting-row:first-child {
  padding-top: 2px;
}
.setting-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.setting-name {
  font-size: 13.5px;
  font-weight: 600;
}
.setting-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}
.setting-action {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.port-input {
  width: 96px;
  text-align: right;
  font-family: var(--font-mono);
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 32px;
}
.info-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
}
.info-item dt {
  font-size: 12.5px;
  color: var(--text-muted);
}
.info-item dd {
  font-size: 12.5px;
  font-weight: 500;
}

@media (max-width: 640px) {
  .info-grid {
    grid-template-columns: 1fr;
  }
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
