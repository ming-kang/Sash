<template>
  <article class="connection-row">
    <div class="connection-main">
      <div class="connection-host mono" :title="host">
        {{ host }}
      </div>
      <div class="connection-tags">
        <span class="connection-tag tag-network">{{ connection.metadata.network.toUpperCase() }}</span>
        <span v-if="process !== '-'" class="connection-tag tag-process" :title="connection.metadata.processPath">
          {{ process }}
        </span>
        <span
          v-for="chain in connection.chains"
          :key="chain"
          class="connection-tag tag-chain"
        >
          {{ chain }}
        </span>
        <span class="connection-tag tag-rule" :title="connection.rulePayload">
          {{ connection.rule || '-' }}<template v-if="connection.rulePayload">,{{ connection.rulePayload }}</template>
        </span>
        <span class="connection-tag tag-time">{{ formatAgo(connection.start) }}</span>
        <span class="connection-tag tag-traffic mono">
          ↑{{ formatBytes(connection.upload) }} ↓{{ formatBytes(connection.download) }}
        </span>
      </div>
    </div>
    <button
      type="button"
      class="connection-close"
      :aria-label="t('connections.closeTitle')"
      :title="t('connections.closeTitle')"
      @click="emit('close', connection.id)"
    >
      <Icon name="x" :size="18" />
    </button>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import { t } from "../i18n/index.js";
import type { ConnectionItem } from "../types/index.js";
import { formatAgo, formatBytes } from "../utils/format.js";

const props = defineProps<{
  connection: ConnectionItem;
}>();

const emit = defineEmits<{
  close: [id: string];
}>();

const host = computed(() => {
  const meta = props.connection.metadata;
  if (meta.host) return meta.host;
  return `${meta.destinationIP}:${meta.destinationPort}`;
});

const process = computed(() => {
  const path = props.connection.metadata.processPath;
  return path ? (path.split(/[\\/]/).pop() ?? path) : "-";
});
</script>

<style scoped>
.connection-row {
  content-visibility: auto;
  contain-intrinsic-block-size: auto 54px;
  position: relative;
  display: flex;
  min-height: 54px;
  align-items: center;
  padding: 8px 48px 8px 20px;
  border-bottom: 1px solid var(--border);
  transition: background var(--motion-fast) var(--ease-standard);
}
.connection-row:hover {
  background: var(--general-row-hover);
}
.connection-main {
  min-width: 0;
  flex: 1;
}
.connection-host {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-tags {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 5px;
}
.connection-tag {
  display: inline-flex;
  max-width: 320px;
  min-height: 19px;
  align-items: center;
  padding: 1px 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--bg-inset);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-network {
  background: var(--info-soft);
  border-color: var(--info-border);
  color: var(--info);
}
.tag-chain {
  background: var(--selection-soft);
  border-color: var(--selection-border);
  color: var(--selection);
}
.tag-traffic {
  background: var(--accent-soft);
  border-color: var(--border-accent);
  color: var(--accent);
}
.connection-close {
  position: absolute;
  top: 50%;
  right: 18px;
  display: flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transform: translateY(-50%);
  transition:
    background var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}
.connection-close:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

@media (max-width: 760px) {
  .connection-row {
    padding-right: 48px;
    padding-left: 8px;
  }
  .connection-close {
    right: 4px;
    width: 40px;
    height: 40px;
  }
}

@media (max-width: 480px) {
  .connection-tag {
    max-width: 220px;
  }
}
</style>
