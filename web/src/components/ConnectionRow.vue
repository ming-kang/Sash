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
  position: relative;
  display: flex;
  min-height: 49px;
  align-items: center;
  padding: 5px 46px 5px 20px;
  border-bottom: 1px solid var(--border);
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
  font-size: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-tags {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 3px;
}
.connection-tag {
  display: inline-flex;
  max-width: 320px;
  min-height: 18px;
  align-items: center;
  padding: 1px 5px;
  overflow: hidden;
  border-radius: 3px;
  color: var(--text-inverse);
  font-size: 12px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-network {
  background: var(--tag-network);
}
.tag-process {
  background: var(--tag-process);
}
.tag-chain {
  background: var(--tag-chain);
}
.tag-rule {
  background: var(--tag-rule);
}
.tag-time {
  background: var(--tag-time);
}
.tag-traffic {
  background: var(--tag-traffic);
}
.connection-close {
  position: absolute;
  top: 50%;
  right: 20px;
  display: flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transform: translateY(-50%);
}
.connection-close:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

@media (max-width: 760px) {
  .connection-row {
    padding-right: 40px;
    padding-left: 8px;
  }
  .connection-close {
    right: 8px;
  }
}

@media (max-width: 480px) {
  .connection-tag {
    max-width: 220px;
  }
}
</style>
