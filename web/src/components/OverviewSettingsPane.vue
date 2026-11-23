<template>
  <div class="settings-grid">
    <section class="card card-list preferences-card" :aria-label="t('settings.preferencesTitle')">
      <div class="setting-row">
        <span class="setting-name">{{ t('settings.themeTitle') }}</span>
        <div
          class="segmented preference-control"
          role="group"
          :aria-label="t('settings.themeTitle')"
        >
          <button
            v-for="option in themeOptions"
            :key="option"
            type="button"
            class="segmented-item"
            :class="{ active: theme === option }"
            :aria-pressed="theme === option"
            @click="switchTheme(option)"
          >
            {{ t(`theme.${option}`) }}
          </button>
        </div>
      </div>

      <div class="setting-row">
        <span class="setting-name">{{ t('settings.langTitle') }}</span>
        <div class="segmented preference-control" role="group" :aria-label="t('settings.langTitle')">
          <button
            v-for="option in localeOptions"
            :key="option.id"
            type="button"
            class="segmented-item"
            :class="{ active: locale === option.id }"
            :aria-pressed="locale === option.id"
            @click="switchLocale(option.id)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <AutostartRow />
    </section>

    <section class="card card-list" :aria-label="t('settings.runtimeTitle')">
      <dl class="info-grid">
        <div class="info-item">
          <dt>{{ t('overview.daemonPort') }}</dt>
          <dd class="mono" v-tooltip="daemonAddress">{{ daemonAddress }}</dd>
        </div>
        <div class="info-item">
          <dt>{{ t('overview.controller') }}</dt>
          <dd class="mono" v-tooltip="controller">{{ controller }}</dd>
        </div>
        <div class="info-item">
          <dt>{{ t('settings.coreVersion') }}</dt>
          <dd class="core-version">
            <span class="mono version-current" v-tooltip="coreVersion || '-'">
              {{ coreVersion || '-' }}
            </span>
            <template v-if="coreUpdateCheck.status === 'available'">
              <span
                class="version-target mono"
                v-tooltip="t('settings.updateAvailable', { v: updateTarget })"
              >
                → {{ updateTarget }}
              </span>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                :disabled="coreActionBusy"
                @click="startCoreUpdate"
              >
                <Icon
                  :name="coreActionBusy ? 'loader' : 'download'"
                  :size="13"
                  :class="{ spin: coreActionBusy }"
                />
                <span>{{ updatingCore ? t('common.loading') : t('settings.updateNow') }}</span>
              </button>
            </template>
            <button
              v-else
              type="button"
              class="icon-btn version-check"
              :class="`check-${coreUpdateCheck.status}`"
              :disabled="coreActionBusy"
              v-tooltip="checkTooltip"
              :aria-label="checkTooltip"
              @click="refreshCoreUpdateCheck"
            >
              <Icon
                :name="checkIcon"
                :size="14"
                :class="{ spin: coreUpdateCheck.status === 'checking' }"
              />
            </button>
          </dd>
        </div>
      </dl>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import {
  coreUpdateCheck,
  coreVersion,
  normalizeCoreVersion,
  refreshCoreUpdateCheck,
  startCoreUpdate,
  updatingCore,
} from "../composables/core-runtime.js";
import { locale, setLocale, t, type Locale } from "../i18n/index.js";
import { store } from "../stores/index.js";
import { setTheme, theme, type Theme } from "../theme.js";
import AutostartRow from "./AutostartRow.vue";
import Icon from "./Icon.vue";

const themeOptions: Theme[] = ["system", "light", "dark"];
const localeOptions: Array<{ id: Locale; label: string }> = [
  { id: "zh", label: "中文" },
  { id: "en", label: "English" },
];

const daemonAddress = computed(() => `127.0.0.1:${store.status?.settings.daemonPort ?? 19090}`);
const controller = computed(() => store.status?.settings.controller || "-");

const updateTarget = computed(() => normalizeCoreVersion(coreUpdateCheck.value.target ?? undefined));
const coreActionBusy = computed(
  () => updatingCore.value || Boolean(store.status?.coreUpdate),
);
const checkIcon = computed(() => {
  switch (coreUpdateCheck.value.status) {
    case "checking":
      return "loader";
    case "error":
      return "warning";
    case "current":
      return "check-circle";
    default:
      return "refresh";
  }
});
const checkTooltip = computed(() => {
  const check = coreUpdateCheck.value;
  if (check.status === "error")
    return `${t("settings.checkUpdateFailed")}${check.error ? ` · ${check.error}` : ""}`;
  if (check.status === "current") return t("settings.upToDate");
  return t("settings.checkUpdate");
});

onMounted(() => {
  if (coreUpdateCheck.value.status === "idle") void refreshCoreUpdateCheck();
});

function switchTheme(next: Theme): void {
  if (next !== theme.value) setTheme(next);
}

function switchLocale(next: Locale): void {
  if (next === locale.value) return;
  setLocale(next);
}
</script>

<style scoped>
.settings-grid {
  display: grid;
  width: 100%;
  grid-template-columns: 1fr;
  gap: 12px;
}
.preferences-card {
  container-type: inline-size;
}
.preference-control {
  display: inline-grid;
  width: 224px;
  max-width: 100%;
  grid-auto-columns: 1fr;
  grid-auto-flow: column;
  flex-shrink: 0;
  gap: 3px;
}
@container (max-width: 399px) {
  .preferences-card > .setting-row:not(.autostart-row) {
    min-height: 0;
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
  }
  .preference-control {
    width: 100%;
  }
}
.preference-control .segmented-item {
  min-width: 56px;
  min-height: 30px;
  padding-inline: 8px;
  border: 0;
  border-radius: var(--radius-sm);
  font-size: 13px;
}

.setting-row {
  display: flex;
  min-height: 52px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 6px;
  transition: background var(--motion-fast) var(--ease-standard);
}
.setting-row + .setting-row,
.info-item + .info-item {
  border-top: 1px solid var(--border);
}
.setting-row:hover {
  background: var(--general-row-hover);
  border-radius: var(--radius-sm);
}
.setting-name {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 550;
}
.info-item {
  display: flex;
  min-width: 0;
  min-height: 42px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 6px;
}
.info-item dt {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.4;
}
.info-item dd {
  max-width: 65%;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.info-item dd.core-version {
  display: flex;
  max-width: 80%;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  overflow: visible;
}
.version-current {
  overflow: hidden;
  text-overflow: ellipsis;
}
.version-target {
  color: var(--accent);
  font-weight: 600;
  white-space: nowrap;
}
.version-check.check-current {
  color: var(--success);
}
.version-check.check-error {
  color: var(--warning);
}

@media (max-width: 760px) {
  .preference-control .segmented-item {
    min-height: 40px;
  }
}

@media (max-width: 480px) {
  .settings-grid {
    gap: 14px;
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
}
</style>
