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
        <span class="mode-code">
          <Icon v-if="pendingMode === mode.id" name="loader" :size="12" class="spin" />
          <template v-else>{{ mode.id.toUpperCase() }}</template>
        </span>
        <span class="mode-name">{{ mode.label }}</span>
      </button>
    </div>
    <div class="mode-switcher toggle-switcher" role="group" :aria-label="t('overview.switchesTitle')">
      <button
        type="button"
        class="mode-button toggle-button"
        :class="{ active: isSysProxyOn }"
        :aria-pressed="isSysProxyOn"
        :disabled="!canToggleSystemProxy"
        @click="toggleSystemProxy(!isSysProxyOn)"
      >
        <span class="toggle-name">{{ t('overview.sysProxyTitle') }}</span>
        <span class="toggle-state">{{ isSysProxyOn ? t('common.on') : t('common.off') }}</span>
      </button>
      <button
        type="button"
        class="mode-button toggle-button"
        :class="{ active: allowLanOn }"
        :aria-pressed="allowLanOn"
        :disabled="store.operations.networkSetting || !store.status"
        @click="toggleAllowLan(!allowLanOn)"
      >
        <span class="toggle-name">{{ t('overview.lan') }}</span>
        <span class="toggle-state">{{ allowLanOn ? t('common.on') : t('common.off') }}</span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import Icon from "./Icon.vue";
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
  padding: 13px 17px;
  background: var(--bg-app);
  border-bottom: 1px solid var(--border);
}
.mode-switcher {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}
.mode-button {
  display: flex;
  min-width: 0;
  min-height: 48px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 1px;
  padding: 6px 4px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--mode-button-bg);
  box-shadow: var(--shadow-card);
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard),
    opacity var(--motion-fast) var(--ease-standard);
}
.mode-button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.mode-button.active {
  background: var(--mode-button-active-bg);
  color: var(--mode-button-active-text);
}
.mode-button:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}
.mode-button.pending {
  opacity: 1;
  color: var(--accent);
}
.mode-code {
  display: inline-flex;
  min-height: 15px;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.055em;
}
.mode-name {
  overflow: hidden;
  max-width: 100%;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toggle-switcher {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 13px;
  padding-top: 13px;
  border-top: 1px solid var(--border);
}
.toggle-name {
  overflow: hidden;
  max-width: 100%;
  font-size: 14px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toggle-state {
  font-size: 12px;
  opacity: 0.85;
}
.toggle-button.active .toggle-state {
  color: inherit;
}
.spin {
  animation: rotate 0.9s linear infinite;
}
</style>
