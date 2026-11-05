<template>
  <div class="settings-grid">
    <section class="card card-list" :aria-label="t('settings.preferencesTitle')">
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

      <div ref="portRow" class="setting-row port-row">
        <label class="setting-name" for="mixed-port">{{ t('settings.mixedPortTitle') }}</label>
        <div class="setting-action">
          <input
            id="mixed-port"
            ref="portInput"
            v-model.number="mixedPort"
            type="number"
            min="1"
            max="65535"
            class="input input-sm port-input"
            :class="{ 'input-invalid': portInvalid }"
            :aria-invalid="portInvalid || undefined"
            :aria-describedby="portInvalid ? 'mixed-port-hint' : undefined"
            :disabled="portLocked"
            @keydown.enter.prevent="saveMixedPort"
            @keydown.esc="resetMixedPort"
          />
          <template v-if="portDirty">
            <button
              type="button"
              class="icon-btn port-reset"
              :title="t('common.reset')"
              :aria-label="t('common.reset')"
              :disabled="portLocked"
              @click="resetMixedPort"
            >
              <Icon name="x" :size="14" />
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="portLocked || !portValid"
              @click="saveMixedPort"
            >
              {{ savingPort ? t('common.loading') : t('common.save') }}
            </button>
          </template>
        </div>
      </div>
      <p v-if="portInvalid" id="mixed-port-hint" class="port-hint" role="alert">
        {{ t('settings.portInvalid') }}
      </p>
    </section>

    <section class="card card-list" :aria-label="t('settings.runtimeTitle')">
      <dl class="info-grid">
        <div class="info-item">
          <dt>{{ t('overview.daemonPort') }}</dt>
          <dd class="mono" :title="daemonAddress">{{ daemonAddress }}</dd>
        </div>
        <div class="info-item">
          <dt>{{ t('overview.controller') }}</dt>
          <dd class="mono" :title="controller">{{ controller }}</dd>
        </div>
        <div class="info-item">
          <dt>{{ t('settings.coreVersion') }}</dt>
          <dd class="mono" :title="coreVersion || '-'">{{ coreVersion || '-' }}</dd>
        </div>
      </dl>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { coreVersion } from "../composables/core-runtime.js";
import { locale, setLocale, t, type Locale } from "../i18n/index.js";
import {
  errorText,
  saveNetworkSettings,
  store,
  toast,
} from "../stores/index.js";
import { setTheme, theme, type Theme } from "../theme.js";
import AutostartRow from "./AutostartRow.vue";
import Icon from "./Icon.vue";

const themeOptions: Theme[] = ["system", "light", "dark"];
const localeOptions: Array<{ id: Locale; label: string }> = [
  { id: "zh", label: "中文" },
  { id: "en", label: "English" },
];

const committedMixedPort = ref(store.status?.settings.mixedPort ?? 7890);
const mixedPort = ref(committedMixedPort.value);

const portRow = ref<HTMLElement | null>(null);
const portInput = ref<HTMLInputElement | null>(null);
const savingPort = ref(false);
const portLocked = computed(
  () => savingPort.value || store.operations.networkSetting || !store.status,
);
const daemonAddress = computed(() => `127.0.0.1:${store.status?.settings.daemonPort ?? 19090}`);
const controller = computed(() => store.status?.settings.controller || "-");

watch(
  () => store.status?.settings.mixedPort,
  (next) => {
    if (next === undefined) return;
    const previous = committedMixedPort.value;
    committedMixedPort.value = next;
    if (!savingPort.value && Object.is(mixedPort.value, previous)) mixedPort.value = next;
  },
);

const portDirty = computed(() => !Object.is(mixedPort.value, committedMixedPort.value));
const portInRange = computed(
  () => Number.isInteger(mixedPort.value) && mixedPort.value >= 1 && mixedPort.value <= 65535,
);
const portInvalid = computed(() => portDirty.value && !portInRange.value);
const portValid = computed(() => portDirty.value && portInRange.value);

function switchTheme(next: Theme): void {
  if (next !== theme.value) setTheme(next);
}

function switchLocale(next: Locale): void {
  if (next === locale.value) return;
  setLocale(next);
}

const focusInPortRow = (): boolean => !!portRow.value?.contains(document.activeElement);

// Saving disables the field and Reset/Save unmount once the port is clean, either of which would
// drop keyboard focus to <body>; hand it back to the field.
async function restorePortFocus(hadFocus: boolean): Promise<void> {
  if (!hadFocus) return;
  await nextTick();
  portInput.value?.focus();
}

function resetMixedPort(): void {
  const hadFocus = focusInPortRow();
  mixedPort.value = committedMixedPort.value;
  void restorePortFocus(hadFocus);
}

async function saveMixedPort(): Promise<void> {
  if (!portValid.value || portLocked.value) return;
  const hadFocus = focusInPortRow();
  savingPort.value = true;
  try {
    if (!(await saveNetworkSettings({ mixedPort: mixedPort.value }))) {
      toast.info(t("toast.settingSavedUnverified"));
    }
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    savingPort.value = false;
    await restorePortFocus(hadFocus);
  }
}
</script>

<style scoped>
.settings-grid {
  display: grid;
  width: 100%;
  grid-template-columns: 1fr;
  gap: 12px;
}
/* Equal-width options sized by the longest label, so two- and three-option controls share a rhythm. */
.preference-control {
  display: inline-grid;
  grid-auto-columns: 1fr;
  grid-auto-flow: column;
  flex-shrink: 0;
  gap: 3px;
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
/* Separators sit above each following row, so a trailing hint or error never leaves a stray rule. */
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
.port-input.input-invalid {
  border-color: var(--danger);
}
.port-hint {
  margin: 0 6px 8px;
  color: var(--danger);
  font-size: 12px;
  text-align: right;
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

@media (max-width: 760px) {
  .preference-control .segmented-item,
  .setting-action .btn {
    min-height: 40px;
  }
  .port-reset {
    width: 40px;
    height: 40px;
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
  .port-row .setting-action {
    align-self: stretch;
  }
  .port-input {
    flex: 1;
    width: auto;
    min-height: 44px;
    text-align: left;
  }
  .setting-action .btn {
    min-height: 44px;
  }
  .port-reset {
    width: 44px;
    height: 44px;
  }
  .port-hint {
    text-align: left;
  }
}
</style>
