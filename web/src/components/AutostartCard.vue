<template>
  <UiCard :title="t('autostart.title')" class="autostart-card">
    <div class="autostart-row" :aria-busy="busy">
      <div class="autostart-info">
        <span class="autostart-desc">{{ t('autostart.description') }}</span>
        <span id="autostart-state" class="autostart-state" role="status">{{ stateText }}</span>
        <span v-if="status?.reason" class="autostart-reason">{{ status.reason }}</span>
      </div>
      <UiSwitch
        :model-value="status?.state === 'on'"
        :label="t('autostart.title')"
        aria-describedby="autostart-state"
        :disabled="switchDisabled"
        @update:model-value="save"
      />
    </div>
    <div class="autostart-actions">
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="busy || !owner"
        @click="refresh"
      >
        <Icon name="refresh" :size="14" :class="{ spin: busy }" />
        {{ t('autostart.refresh') }}
      </button>
      <button
        v-if="status && ['stale', 'disabled', 'unknown'].includes(status.state)"
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="busy || !owner"
        @click="save(false)"
      >
        {{ t('autostart.remove') }}
      </button>
    </div>
  </UiCard>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { sessionReady } from "../api/index.js";
import { useAutostart } from "../composables/autostart.js";
import { t } from "../i18n/index.js";
import { errorText, store, toast } from "../stores/index.js";
import Icon from "./Icon.vue";
import UiCard from "./UiCard.vue";
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

async function save(enabled: boolean): Promise<void> {
  try {
    if (await setEnabled(enabled)) toast.success(t("toast.settingSaved"));
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  }
}
</script>

<style scoped>
.autostart-row {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 6px 5px;
}
.autostart-info {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
  overflow-wrap: anywhere;
}
.autostart-desc {
  color: var(--text-primary);
  font-size: 16px;
}
.autostart-state,
.autostart-reason {
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.4;
}
.autostart-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  padding: 6px 5px;
}
@media (max-width: 760px) {
  .autostart-actions .btn {
    min-height: 40px;
  }
}
</style>
