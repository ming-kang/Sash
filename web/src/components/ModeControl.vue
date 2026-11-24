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
      <div class="network-toggle">
        <span class="toggle-name">{{ t('tun.title') }}</span>
        <UiSwitch
          :model-value="store.status?.settings.tun?.enable ?? false"
          :label="t('tun.title')"
          :disabled="store.operations.networkSetting || !store.status || (!tun?.privilege.installed && !store.status.settings.tun?.enable)"
          @update:model-value="toggleTun"
        />
      </div>
    </div>
    <div v-if="tun" class="tun-details">
      <span>{{ t('tun.desired') }}: {{ tun.desired ? t('tun.on') : t('tun.off') }}</span>
      <span>{{ t('tun.applied') }}: {{ tun.applied ? t('tun.on') : t('tun.off') }}</span>
      <span v-if="tun.applied">{{ t('tun.networkNotChecked') }}</span>
      <span v-if="!tun.supported">{{ t('tun.unsupported') }}</span>
      <button v-else-if="tun.privilege.installed === false || tun.privilege.needsReconsent" type="button"
        :disabled="installingHelper" @click="installHelper">
        {{ t(tun.privilege.needsReconsent ? 'tun.reconsent' : 'tun.install') }}
      </button>
      <span v-if="tun.desired !== tun.applied">{{ t('tun.apply') }}</span>
      <span v-if="tun.applied && isSysProxyOn">{{ t('tun.proxyHint') }}</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { TunStatusResponse } from "../../../src/contracts.js";
import { api } from "../api/index.js";
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
const tun = ref<TunStatusResponse>();
const installingHelper = ref(false);

watch(
  [() => store.status?.daemon.bootId, () => store.status?.revisions.state, () => store.status?.revisions.runtime],
  async ([bootId], _previous, onCleanup) => {
    let current = true;
    onCleanup(() => { current = false; });
    try {
      const observed = bootId ? await api.getTun() : undefined;
      if (current) tun.value = observed;
    } catch {
      if (current) tun.value = undefined;
    }
  },
  { immediate: true },
);

async function installHelper(): Promise<void> {
  installingHelper.value = true;
  const bootId = store.status?.daemon.bootId;
  try {
    const status = await api.installTunHelper();
    if (bootId === store.status?.daemon.bootId) tun.value = status;
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    installingHelper.value = false;
  }
}

async function toggleTun(enable: boolean): Promise<void> {
  try {
    if (!(await saveNetworkSettings({ tun: { enable } })))
      toast.info(t("toast.settingSavedUnverified"));
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}

async function switchMode(mode: RoutingMode): Promise<void> {
  if (mode === store.mode || pendingMode.value) return;
  pendingMode.value = mode;
  try {
    await setOutboundMode(mode);
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    pendingMode.value = null;
  }
}

async function toggleSystemProxy(target: boolean): Promise<void> {
  try {
    if (!(await setSystemProxyEnabled(target))) toast.info(t("toast.settingSavedUnverified"));
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}

async function toggleAllowLan(next: boolean): Promise<void> {
  try {
    if (!(await saveNetworkSettings({ allowLan: next }))) {
      toast.info(t("toast.settingSavedUnverified"));
    }
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}
</script>

<style scoped>
.tun-details {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 8px;
  font-size: 0.8rem;
}
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
</style>
