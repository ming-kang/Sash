<template>
  <div class="setting-row autostart-row" :aria-busy="busy">
    <div class="autostart-info">
      <span class="autostart-title">{{ t('autostart.title') }}</span>
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
      <UiSwitch
        :model-value="status?.state === 'on'"
        :label="t('autostart.title')"
        aria-describedby="autostart-state"
        :disabled="switchDisabled"
        @update:model-value="save"
      />
    </div>
    <div v-if="stateHint || reasonText" class="autostart-notice">
      <Icon name="warning" :size="15" />
      <div class="autostart-message">
        <span v-if="stateHint" class="autostart-state">{{ stateHint }}</span>
        <span v-if="reasonText" class="autostart-reason">{{ reasonText }}</span>
        <button
          v-if="canRemove"
          type="button"
          class="btn btn-secondary btn-xs autostart-remove"
          :disabled="busy || !owner"
          @click="save(false)"
        >
          {{ t('autostart.remove') }}
        </button>
      </div>
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
  flex-wrap: wrap;
  row-gap: 10px;
}
.autostart-info {
  min-width: max-content;
  flex: 1;
}
.autostart-title {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 550;
  white-space: nowrap;
}
.autostart-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 10px;
  margin-left: auto;
}
.autostart-refresh {
  color: var(--text-muted);
}
.autostart-notice {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  background: var(--warning-soft);
  border: 1px solid var(--warning-border);
  border-radius: var(--radius-sm);
  color: var(--warning);
}
.autostart-message {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  overflow-wrap: anywhere;
}
.autostart-state,
.autostart-reason {
  font-size: 12px;
  line-height: 1.5;
}
.autostart-state {
  font-weight: 600;
}
.autostart-reason {
  color: var(--text-secondary);
}
.autostart-remove {
  align-self: flex-start;
  margin-top: 3px;
}
@media (max-width: 760px) {
  .autostart-refresh {
    width: 40px;
    height: 40px;
  }
  .autostart-remove {
    min-height: 40px;
  }
}
@media (max-width: 480px) {
  .setting-row.autostart-row {
    align-items: center;
    flex-direction: row;
    gap: 12px;
  }
  .autostart-actions {
    align-self: center;
    gap: 4px;
  }
}
</style>
