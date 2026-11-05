<template>
  <div class="general-column">
    <aside class="general-pane" :aria-label="t('overview.coreTitle')">
      <ModeControl :is-core-ready="isCoreReady" />

      <div class="general-list">
        <CoreStatus class="mobile-core-status" />

        <div class="general-row port-row">
          <div class="general-label">
            <label for="mixed-port">{{ t('overview.mixedPort') }}</label>
            <span v-if="portInvalid" id="mixed-port-hint" class="port-hint" role="alert">
              {{ t('settings.portInvalid') }}
            </span>
          </div>
          <div class="general-value port-value" :title="t('settings.mixedPortTitle')">
            <span class="port-prefix mono">127.0.0.1:</span>
            <!-- The underline is the field: the port edits in place instead of a second row. -->
            <input
              id="mixed-port"
              ref="portInput"
              v-model.number="mixedPort"
              type="number"
              min="1"
              max="65535"
              inputmode="numeric"
              class="port-input mono"
              :class="{ invalid: portInvalid }"
              :aria-label="t('overview.mixedPort')"
              :aria-invalid="portInvalid || undefined"
              :aria-describedby="portInvalid ? 'mixed-port-hint' : undefined"
              :disabled="portLocked"
              @keydown.enter.prevent="saveMixedPort"
              @keydown.esc="resetMixedPort"
              @blur="commitMixedPort"
            />
          </div>
        </div>

        <div class="general-row profile-row">
          <div class="general-label">{{ t('overview.subTitle') }}</div>
          <div v-if="activeProfile" class="general-value profile-value">
            <button
              type="button"
              class="general-link profile-name"
              :title="activeProfile.url || activeProfile.name"
              @click="navigate('profiles')"
            >
              {{ activeProfile.name }}
            </button>
            <button
              v-if="activeProfile.url"
              type="button"
              class="icon-btn"
              :class="{ spin: refreshingSub }"
              :title="t('profiles.update')"
              :aria-label="t('profiles.update')"
              :disabled="refreshingSub"
              @click="refreshActiveProfile"
            >
              <Icon name="refresh" :size="14" />
            </button>
          </div>
          <button v-else type="button" class="btn btn-primary btn-sm" @click="navigate('profiles')">
            {{ t('overview.subSet') }}
          </button>
        </div>
      </div>

      <section class="traffic-compact" :aria-label="t('overview.trafficTitle')">
        <div class="traffic-metrics">
          <div class="traffic-metric">
            <span>{{ t('overview.download') }}</span>
            <strong class="mono down-value">{{ formatSpeed(store.traffic.down) }}</strong>
          </div>
          <div class="traffic-metric">
            <span>{{ t('overview.upload') }}</span>
            <strong class="mono up-value">{{ formatSpeed(store.traffic.up) }}</strong>
          </div>
        </div>
        <TrafficChart
          :down="store.traffic.historyDown"
          :up="store.traffic.historyUp"
          :height="104"
          :label="t('overview.trafficTitle')"
        />
        <div class="traffic-totals">
          <span>
            {{ t('overview.totalDown') }}
            <strong class="mono">{{ formatBytes(store.connectionsDownloadTotal) }}</strong>
          </span>
          <span>
            {{ t('overview.totalUp') }}
            <strong class="mono">{{ formatBytes(store.connectionsUploadTotal) }}</strong>
          </span>
        </div>
      </section>
    </aside>
    <OverviewSettingsPane />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { t } from "../i18n/index.js";
import { navigate } from "../router.js";
import {
  errorText,
  isCoreReady,
  saveNetworkSettings,
  store,
  toast,
  updateProfile,
} from "../stores/index.js";
import { formatBytes, formatSpeed } from "../utils/format.js";
import CoreStatus from "./CoreStatus.vue";
import Icon from "./Icon.vue";
import ModeControl from "./ModeControl.vue";
import OverviewSettingsPane from "./OverviewSettingsPane.vue";
import TrafficChart from "./TrafficChart.vue";

const refreshingSub = ref(false);
const activeProfile = computed(() => {
  const applied = store.status?.configuration.appliedProfile;
  return applied ? store.profiles.find((profile) => profile.id === applied.id) ?? applied : null;
});

// The port row shows the saved setting and edits it in place; the sidebar's Apply prompt
// reports that a running Core still uses the old port.
const committedMixedPort = ref(store.status?.settings.mixedPort ?? 7890);
const mixedPort = ref(committedMixedPort.value);
const portInput = ref<HTMLInputElement | null>(null);
const savingPort = ref(false);
const portLocked = computed(
  () => savingPort.value || store.operations.networkSetting || !store.status,
);

watch(
  () => store.status?.settings.mixedPort,
  (next) => {
    if (next === undefined) return;
    const previous = committedMixedPort.value;
    committedMixedPort.value = next;
    if (!savingPort.value && Object.is(mixedPort.value, previous)) mixedPort.value = next;
  },
);

const portInRange = computed(
  () => Number.isInteger(mixedPort.value) && mixedPort.value >= 1 && mixedPort.value <= 65535,
);
const portDirty = computed(() => !Object.is(mixedPort.value, committedMixedPort.value));
const portInvalid = computed(() => !portInRange.value);

function resetMixedPort(): void {
  mixedPort.value = committedMixedPort.value;
}

async function saveMixedPort(): Promise<void> {
  if (!portDirty.value || !portInRange.value || portLocked.value) return;
  // Saving disables the field, which would drop keyboard focus to the page; hand it back after.
  const hadFocus = document.activeElement === portInput.value;
  savingPort.value = true;
  try {
    if (!(await saveNetworkSettings({ mixedPort: mixedPort.value }))) {
      toast.info(t("toast.settingSavedUnverified"));
    }
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    savingPort.value = false;
    if (hadFocus) {
      await nextTick();
      portInput.value?.focus();
    }
  }
}

// Inline editing commits on its own: leaving the field saves a valid port and discards a bad one.
function commitMixedPort(): void {
  if (portDirty.value && portInRange.value) void saveMixedPort();
  else resetMixedPort();
}

async function refreshActiveProfile(): Promise<void> {
  const profile = activeProfile.value;
  if (!profile?.url || refreshingSub.value) return;
  refreshingSub.value = true;
  try {
    await updateProfile(profile.id);
    toast.success(t("toast.profileUpdated", { name: profile.name }));
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    refreshingSub.value = false;
  }
}
</script>

<style scoped>
.general-column {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 24px;
}
.general-pane {
  min-width: 0;
  flex-shrink: 0;
  overflow: hidden;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
.traffic-compact {
  padding: 18px;
}
.general-list {
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
}
.general-row {
  display: flex;
  min-height: 46px;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  transition: background var(--motion-fast) var(--ease-standard);
}
.general-row:last-child {
  border-bottom: 0;
}
.general-row:hover {
  background: var(--general-row-hover);
}
.general-label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  color: var(--text-primary);
  font-size: 14px;
}
.general-value {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: right;
}
.mobile-core-status {
  display: none;
}
/* The port edits in place, so the row reads 127.0.0.1:[17891] with one underline. */
.port-value {
  align-items: baseline;
  gap: 2px;
  color: var(--text-muted);
  font-size: 13px;
}
.port-prefix {
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.port-input {
  /* Room for five digits plus the inline padding; narrower clips the last one. */
  width: 6ch;
  flex-shrink: 0;
  padding: 1px 2px 2px;
  border: 0;
  border-bottom: 1px dashed var(--border-strong);
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  appearance: textfield;
  transition:
    border-color var(--motion-fast) var(--ease-standard),
    background var(--motion-fast) var(--ease-standard);
}
.port-input::-webkit-outer-spin-button,
.port-input::-webkit-inner-spin-button {
  margin: 0;
  -webkit-appearance: none;
}
.port-input:hover:not(:disabled) {
  border-bottom-color: var(--accent);
}
.port-input:focus {
  border-bottom: 1px solid var(--accent);
  outline-offset: 1px;
  background: var(--bg-inset);
  border-radius: var(--radius-xs) var(--radius-xs) 0 0;
}
.port-input.invalid {
  border-bottom-color: var(--danger);
  color: var(--danger);
}
.port-input:disabled {
  border-bottom-style: solid;
  color: var(--text-muted);
}
.port-hint {
  margin-top: 2px;
  color: var(--danger);
  font-size: 11px;
  line-height: 1.35;
}
.profile-value {
  max-width: 58%;
  gap: 7px;
}
.general-link {
  min-width: 0;
  padding: 0 0 1px;
  overflow: hidden;
  border: 0;
  border-bottom: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: inherit;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    border-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}
.general-link:hover {
  border-bottom-color: var(--accent);
  color: var(--accent);
}
.profile-name {
  overflow: hidden;
  color: var(--text-primary);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.traffic-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin: 2px 0 8px;
}
.traffic-metric {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  padding: 4px 0 8px;
  color: var(--text-muted);
  font-size: 12px;
}
.traffic-metric + .traffic-metric {
  padding-left: 16px;
  border-left: 1px solid var(--border);
}
.traffic-metric > span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.traffic-metric > span::before {
  width: 5px;
  height: 5px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--chart-down);
  content: "";
}
.traffic-metric + .traffic-metric > span::before {
  background: var(--chart-up);
}
.traffic-metric strong {
  overflow: hidden;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.025em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.down-value {
  color: var(--chart-down);
}
.up-value {
  color: var(--chart-up);
}
.traffic-totals {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 3px 10px;
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 11px;
}
.traffic-totals strong {
  color: var(--text-secondary);
  font-weight: 500;
}

@media (max-width: 899px) {
  .mobile-core-status {
    display: flex;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  /* The card centers its clock; the phone row keeps it close to the Core label. */
  .mobile-core-status :deep(.core-clock) {
    padding-left: 24px;
    text-align: left;
  }
}

@media (max-width: 420px) {
  .mobile-core-status {
    padding-right: 11px;
    padding-left: 11px;
  }
  .general-row {
    min-height: 52px;
    gap: 10px;
    padding-right: 11px;
    padding-left: 11px;
  }
  .general-value {
    max-width: 58%;
  }
}
</style>
