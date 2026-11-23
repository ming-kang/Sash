<template>
  <PageHeader :title="t(refused ? 'status.refusedTitle' : 'status.offlineTitle')" />
  <section class="connection-panel">
    <p class="connection-hint">{{ t(refused ? 'status.refusedHint' : 'status.offlineHint') }}</p>
    <div class="command-row">
      <code class="mono">{{ COMMAND }}</code>
      <button
        type="button"
        class="icon-btn command-copy"
        :class="{ copied }"
        v-tooltip="copied ? t('common.copied') : t('common.copy')"
        :aria-label="copied ? t('common.copied') : t('common.copy')"
        @click="copyCommand"
      >
        <Icon :name="copied ? 'check' : 'copy'" :size="15" />
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import { t } from "../i18n/index.js";

defineProps<{ refused: boolean }>();

const COMMAND = "sash web";
const copied = ref(false);
let resetTimer: number | undefined;

async function copyCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText(COMMAND);
  } catch {
    // Clipboard access can be denied; the command stays selectable as plain text.
    return;
  }
  copied.value = true;
  window.clearTimeout(resetTimer);
  resetTimer = window.setTimeout(() => {
    copied.value = false;
  }, 1600);
}

onBeforeUnmount(() => window.clearTimeout(resetTimer));
</script>

<style scoped>
.connection-panel {
  max-width: 640px;
  padding: 24px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.6;
}
.connection-hint {
  margin: 0 0 14px;
}
.command-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 16px;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.command-row code {
  min-width: 0;
  flex: 1;
  color: var(--text-primary);
  user-select: all;
}
.command-copy.copied {
  color: var(--success);
}
</style>
