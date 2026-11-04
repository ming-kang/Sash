<template>
  <div class="setting-row autostart-row" :aria-busy="busy">
    <div class="autostart-info">
      <span class="autostart-title">{{ t('autostart.title') }}</span>
      <span v-if="stateHint" class="autostart-state">{{ stateHint }}</span>
      <span v-if="reasonText" class="autostart-reason">{{ reasonText }}</span>
      <span id="autostart-state" class="sr-only" role="status">{{ stateText }}</span>
    </div>
    <div class="autostart-actions">
      <button
        type="button"
        class="icon-btn autostart-refresh"
        :title="t('autostart.refresh')"
        :aria-label="t('autostart.refresh')"
        :disabled="busy || !owner"
        @click="refresh"
      >
        <Icon name="refresh" :size="14" :class="{ spin: busy }" />
      </button>
      <button
        v-if="canRemove"
        type="button"
        class="btn btn-ghost btn-xs"
        :disabled="busy || !owner"
        @click="save(false)"
      >
        {{ t('autostart.remove') }}
      </button>
      <UiSwitch
        :model-value="status?.state === 'on'"
        :label="t('autostart.title')"
        aria-describedby="autostart-state"
        :disabled="switchDisabled"
        @update:model-value="save"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { sessionReady } from "../api/index.js";
import { useAutostart, visibleAutostartReason } from "../composables/autostart.js";
import { t } from "../i18n/index.js";
import { errorText, store, toast } from "../stores/index.js";
import Icon from "./Icon.vue";
import UiSwitch from "./UiSwitch.vue";

const owner = computed(() =>
  sessionReady.value && store.daemonOnline ? (store.status?.daemon.bootId ?? null) : null,
);
const { status, busy, refresh, setEnabled } = useAutostart(owner);
const switchDisabled = computed(
  () =>
    busy.value ||
    !owner.value ||
    !status.value ||
    status.value.state === "unknown" ||
    status.value.state === "unsupported" ||
    (!status.value.canEnable && status.value.state !== "on"),
);
const stateText = computed(() => {
  if (!owner.value) return t("autostart.unavailable");
  if (!status.value) return t("common.loading");
  const labels = {
    on: t("autostart.on"),
    off: t("autostart.off"),
    stale: t("autostart.stale"),
    disabled: t("autostart.disabled"),
    unknown: t("autostart.unknown"),
    unsupported: t("autostart.unsupported"),
  };
  return labels[status.value.state];
});
const stateHint = computed(() =>
  status.value?.state === "on" || status.value?.state === "off" ? null : stateText.value,
);
const reasonText = computed(() => visibleAutostartReason(status.value));
const canRemove = computed(
  () => status.value && ["stale", "disabled", "unknown"].includes(status.value.state),
);

async function save(enabled: boolean): Promise<void> {
  try {
    await setEnabled(enabled);
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}
</script>

<style scoped>
.autostart-row {
  min-width: 0;
}
.autostart-info {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  overflow-wrap: anywhere;
}
.autostart-title {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 550;
}
.autostart-state,
.autostart-reason {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.45;
}
.autostart-state {
  color: var(--warning);
}
.autostart-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 10px;
}
.autostart-refresh {
  color: var(--text-muted);
}
@media (max-width: 760px) {
  .autostart-refresh {
    width: 40px;
    height: 40px;
  }
  .autostart-actions .btn {
    min-height: 40px;
  }
}
@media (max-width: 480px) {
  .setting-row.autostart-row {
    align-items: center;
    flex-direction: row;
    gap: 12px;
  }
  .autostart-info {
    flex: 1;
  }
  .autostart-actions {
    align-self: center;
    gap: 4px;
  }
}
</style>
