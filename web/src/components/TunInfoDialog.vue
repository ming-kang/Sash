<template>
  <Teleport to="body">
    <Transition name="fade" appear>
      <div class="tun-info-overlay" @click.self="emit('close')">
        <div
          ref="dialogElement"
          class="tun-info-dialog card"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
        >
          <div class="tun-info-head">
            <h3 :id="titleId" class="tun-info-title">{{ t("tun.title") }}</h3>
            <button
              v-if="installable"
              v-tooltip="detail"
              type="button"
              class="tun-status-link"
              :disabled="installing"
              @click="emit('install')"
            >
              <Icon v-if="installing" name="loader" :size="12" class="spin" />
              {{ summary }}
            </button>
            <p v-else v-tooltip="detail" class="tun-info-status" :class="{ warn: pending }">
              {{ summary }}
            </p>
          </div>

          <div class="tun-form">
            <div class="tun-seg" role="group" :aria-label="t('tun.stack')">
              <button
                v-for="option in stackOptions"
                :key="option"
                type="button"
                class="tun-seg-button"
                :class="{ active: draft.stack === option }"
                :disabled="saving"
                @click="draft.stack = option"
              >
                {{ option }}
              </button>
            </div>
            <div class="tun-row">
              <span>{{ t("tun.autoRoute") }}</span>
              <UiSwitch
                :model-value="draft.autoRoute"
                :label="t('tun.autoRoute')"
                :disabled="saving"
                @update:model-value="draft.autoRoute = $event"
              />
            </div>
            <div class="tun-row">
              <span>{{ t("tun.strictRoute") }}</span>
              <UiSwitch
                :model-value="draft.strictRoute"
                :label="t('tun.strictRoute')"
                :disabled="saving"
                @update:model-value="draft.strictRoute = $event"
              />
            </div>

            <details class="tun-advanced">
              <summary>{{ t("tun.advanced") }}</summary>
              <div class="tun-field">
                <span class="tun-label">{{ t("tun.dnsHijack") }}</span>
                <TagListInput
                  v-model="draft.dnsHijack"
                  :placeholder="'any:53'"
                  :disabled="saving"
                  :validate="nonEmptyToken"
                />
              </div>
              <div class="tun-field">
                <span class="tun-label">{{ t("tun.routeExclude") }}</span>
                <TagListInput
                  v-model="draft.routeExcludeAddress"
                  :placeholder="'10.0.0.0/8'"
                  :disabled="saving"
                  :validate="cidr"
                />
              </div>
              <div class="tun-field">
                <span class="tun-label">{{ t("tun.device") }}</span>
                <input
                  v-model="draft.device"
                  class="input"
                  type="text"
                  maxlength="64"
                  :placeholder="devicePlaceholder"
                  :disabled="saving"
                />
              </div>
            </details>
          </div>

          <div class="tun-info-actions">
            <button type="button" class="btn btn-secondary btn-sm" :disabled="saving" @click="emit('close')">
              {{ t("common.close") }}
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="saving || !dirty"
              @click="save"
            >
              <Icon v-if="saving" name="loader" :size="13" class="spin" />
              {{ t("common.save") }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, useId } from "vue";
import type { TunHelperStatus } from "../../../src/contracts.js";
import type { TunSettings } from "../../../src/tun-settings.js";
import { useDialogFocus } from "../composables/useDialogFocus.js";
import { t } from "../i18n/index.js";
import { errorText, saveNetworkSettings, toast } from "../stores/index.js";
import Icon from "./Icon.vue";
import TagListInput from "./TagListInput.vue";
import UiSwitch from "./UiSwitch.vue";

const props = defineProps<{
  settings: TunSettings;
  helper: TunHelperStatus | undefined;
  pending: boolean;
  installing: boolean;
}>();
const emit = defineEmits<{ close: []; install: [] }>();

const titleId = `${useId()}-title`;
const dialogElement = ref<HTMLElement | null>(null);

const { open, close } = useDialogFocus({
  container: dialogElement,
  onEscape: () => emit("close"),
});

onMounted(() => {
  void open();
});
onUnmounted(() => {
  close();
});

const stackOptions = ["mixed", "system", "gvisor"] as const satisfies readonly TunSettings["stack"][];
const devicePlaceholder = navigator.userAgent.includes("Mac") ? "utun4" : "tun0";

function editableFields(settings: TunSettings) {
  return {
    stack: settings.stack,
    autoRoute: settings.autoRoute,
    strictRoute: settings.strictRoute,
    dnsHijack: [...settings.dnsHijack],
    routeExcludeAddress: [...settings.routeExcludeAddress],
    device: settings.device ?? "",
  };
}

const draft = reactive(editableFields(props.settings));
const saving = ref(false);

const dirty = computed(
  () => JSON.stringify(draft) !== JSON.stringify(editableFields(props.settings)),
);

function nonEmptyToken(item: string): string | undefined {
  return /\S/.test(item) && !/\s/.test(item) ? undefined : t("tun.invalidEntry");
}

function cidr(item: string): string | undefined {
  return /^\S+\/\d{1,3}$/.test(item) ? undefined : t("tun.invalidCidr");
}

async function save(): Promise<void> {
  if (!dirty.value || saving.value) return;
  saving.value = true;
  try {
    const device = draft.device.trim();
    const applied = await saveNetworkSettings({
      tun: { ...draft, device: device === "" ? null : device },
    });
    if (!applied) toast.info(t("toast.settingSavedUnverified"));
    else emit("close");
  } catch (error) {
    toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    saving.value = false;
  }
}

const installable = computed(
  () => props.helper?.state === "missing" || props.helper?.state === "stale",
);
// Platform-specific reason (another data folder, old protocol, ...), shown on hover.
const detail = computed(() =>
  props.helper && props.helper.state !== "unsupported" ? (props.helper.detail ?? "") : "",
);

const NOT_READY_SUMMARY = {
  unknown: "tun.stateUnknown",
  unsupported: "tun.unsupported",
  stale: "tun.clickReinstall",
  missing: "tun.clickInstall",
} as const;

const summary = computed(() => {
  const state = props.helper?.state ?? "unknown";
  if (state !== "ready") return t(NOT_READY_SUMMARY[state]);
  return t(props.pending ? "tun.statePending" : "tun.ready");
});
</script>

<style scoped>
.tun-info-overlay {
  position: fixed;
  z-index: var(--z-rename);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-scrim);
  inset: 0;
}
.tun-info-dialog {
  width: min(360px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  padding: 16px;
  overflow-y: auto;
}
.tun-info-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.tun-info-title {
  margin: 0;
  font-size: 15px;
}
.tun-info-status {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  text-align: right;
}
.tun-info-status.warn {
  color: var(--warning);
}
.tun-status-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.tun-status-link:disabled {
  cursor: wait;
  opacity: 0.6;
}
.tun-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
}
.tun-row {
  display: flex;
  min-height: 30px;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
  font-size: 13px;
}
.tun-seg {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3px;
  padding: 3px;
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}
.tun-seg-button {
  min-height: 26px;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--mode-button-bg);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.tun-seg-button.active {
  background: var(--mode-button-active-bg);
  color: var(--mode-button-active-text);
  box-shadow: 0 1px 3px var(--accent-shadow);
}
.tun-seg-button:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}
.tun-advanced {
  padding-top: 4px;
}
.tun-advanced > summary {
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  list-style: none;
  user-select: none;
}
.tun-advanced > summary::before {
  display: inline-block;
  margin-right: 4px;
  content: "›";
  transition: transform var(--motion-fast) var(--ease-standard);
}
.tun-advanced[open] > summary::before {
  transform: rotate(90deg);
}
.tun-advanced[open] > summary {
  margin-bottom: 8px;
}
.tun-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 8px;
}
.tun-label {
  color: var(--text-muted);
  font-size: 12px;
}
.tun-info-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 14px;
}
</style>
