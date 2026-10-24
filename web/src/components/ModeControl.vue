<template>
  <section class="mode-control" :aria-label="t('overview.modeTitle')">
    <div class="mode-switcher" role="group" :aria-label="t('overview.modeTitle')">
      <button
        v-for="mode in modes"
        :key="mode.id"
        type="button"
        class="mode-button"
        :class="{ active: store.mode === mode.id, pending: pendingMode === mode.id }"
        :aria-pressed="store.mode === mode.id"
        :aria-busy="pendingMode === mode.id"
        :disabled="store.operations.mode || !isCoreReady"
        @click="switchMode(mode.id)"
      >
        <Icon v-if="pendingMode === mode.id" name="loader" :size="13" class="spin" />
        <span class="mode-name">{{ mode.label }}</span>
      </button>
    </div>

    <div class="network-switches">
      <div class="network-toggle">
        <span class="toggle-name">{{ t('overview.sysProxyTitle') }}</span>
        <UiSwitch
          :model-value="isSysProxyOn"
          :label="t('overview.sysProxyTitle')"
          :disabled="!canToggleSystemProxy"
          @update:model-value="toggleSystemProxy"
        />
      </div>
      <div class="network-toggle">
        <span class="toggle-name">{{ t('overview.lan') }}</span>
        <UiSwitch
          :model-value="allowLanOn"
          :label="t('overview.lan')"
          :disabled="store.operations.networkSetting || !store.status"
          @update:model-value="toggleAllowLan"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "../i18n/index.js";
import {
  canToggleSystemProxy,
  errorText,
  isSysProxyOn,
  saveNetworkSettings,
  setOutboundMode,
  setSystemProxyEnabled,
  store,
  toast,
} from "../stores/index.js";
import type { RoutingMode } from "../types/index.js";
import Icon from "./Icon.vue";
import UiSwitch from "./UiSwitch.vue";

const props = defineProps<{
  isCoreReady: boolean;
}>();

const pendingMode = ref<RoutingMode | null>(null);

const modes = computed(() => [
  { id: "global" as RoutingMode, label: t("overview.modeGlobal") },
  { id: "rule" as RoutingMode, label: t("overview.modeRule") },
  { id: "direct" as RoutingMode, label: t("overview.modeDirect") },
]);

const allowLanOn = computed(() => store.status?.settings.allowLan ?? false);

async function switchMode(mode: RoutingMode): Promise<void> {
  if (mode === store.mode || pendingMode.value) return;
  pendingMode.value = mode;
  try {
    await setOutboundMode(mode);
    toast.success(
      t("toast.modeOk", {
        mode: t(`overview.mode${mode[0]?.toUpperCase()}${mode.slice(1)}`),
      }),
    );
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    pendingMode.value = null;
  }
}

async function toggleSystemProxy(target: boolean): Promise<void> {
  try {
    const verified = await setSystemProxyEnabled(target);
    if (verified) toast.success(t(target ? "toast.sysProxyOn" : "toast.sysProxyOff"));
    else toast.info(t("toast.settingSavedUnverified"));
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}

async function toggleAllowLan(next: boolean): Promise<void> {
  try {
    const verified = await saveNetworkSettings({ allowLan: next });
    if (verified) toast.success(t("toast.settingSaved"));
    else toast.info(t("toast.settingSavedUnverified"));
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}
</script>

<style scoped>
.mode-control {
  padding: 14px 16px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
}
.mode-switcher {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3px;
  padding: 3px;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.mode-button {
  display: flex;
  min-width: 0;
  min-height: 36px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--mode-button-bg);
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--ease-standard),
    box-shadow var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard),
    opacity var(--motion-fast) var(--ease-standard),
    transform var(--motion-fast) var(--ease-standard);
}
.mode-button:hover:not(:disabled) {
  color: var(--text-primary);
}
.mode-button:active:not(:disabled) {
  transform: scale(0.98);
}
.mode-button.active {
  background: var(--mode-button-active-bg);
  box-shadow: 0 1px 3px var(--accent-shadow);
  color: var(--mode-button-active-text);
}
.mode-button:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}
.mode-button.pending {
  opacity: 1;
}
.mode-name {
  overflow: hidden;
  max-width: 100%;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.network-switches {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.network-toggle {
  display: flex;
  min-width: 0;
  min-height: 24px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.toggle-name {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spin {
  animation: rotate 0.9s linear infinite;
}
</style>
