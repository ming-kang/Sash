<template>
  <article class="connection-row">
    <div class="connection-main">
      <div class="connection-host mono" :title="host">
        {{ host }}
      </div>
      <div class="connection-meta">
        <span class="connection-tag tag-network">{{ connection.metadata.network.toUpperCase() }}</span>
        <span v-if="route" class="connection-tag tag-chain" :title="route">{{ route }}</span>
        <span class="meta-text" :title="rule">{{ rule }}</span>
        <span v-if="process" class="meta-text" :title="connection.metadata.processPath">{{ process }}</span>
      </div>
    </div>
    <div class="connection-stats">
      <span class="stat mono" :title="t('overview.download')">
        <span class="stat-arrow down" aria-hidden="true">↓</span>{{ formatBytes(connection.download) }}
      </span>
      <span class="stat mono" :title="t('overview.upload')">
        <span class="stat-arrow up" aria-hidden="true">↑</span>{{ formatBytes(connection.upload) }}
      </span>
      <span class="stat stat-time">{{ formatAgo(connection.start) }}</span>
    </div>
    <button
      type="button"
      class="connection-close"
      :aria-label="t('connections.closeTitle')"
      :title="t('connections.closeTitle')"
      @click="emit('close', connection.id)"
    >
      <Icon name="x" :size="16" />
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
  return path ? (path.split(/[\\/]/).pop() ?? path) : "";
});

// Core lists the chain from the outbound node back to the rule's policy; show it in routing order.
const route = computed(() => [...props.connection.chains].reverse().join(" → "));

const rule = computed(() => {
  const { rule, rulePayload } = props.connection;
  if (!rule) return "-";
  return rulePayload ? `${rule}(${rulePayload})` : rule;
});
</script>

<style scoped>
.connection-row {
  content-visibility: auto;
  contain-intrinsic-block-size: auto 58px;
  display: grid;
  min-height: 58px;
  grid-template-columns: var(--connection-columns, minmax(0, 1fr) 76px 76px 72px 32px);
  align-items: center;
  column-gap: 12px;
  padding: 8px 14px 8px 20px;
  border-bottom: 1px solid var(--border);
  transition: background var(--motion-fast) var(--ease-standard);
}
.connection-row:hover {
  background: var(--general-row-hover);
}
.connection-main {
  min-width: 0;
}
.connection-host {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-meta {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
}
.connection-tag {
  display: inline-flex;
  min-width: 0;
  max-width: 320px;
  min-height: 19px;
  flex-shrink: 0;
  align-items: center;
  padding: 1px 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--bg-inset);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 550;
  line-height: 1.2;
  text-overflow: ellipsis;
}
.tag-network {
  background: var(--info-soft);
  border-color: var(--info-border);
  color: var(--info);
}
.tag-chain {
  flex-shrink: 1;
  background: var(--selection-soft);
  border-color: var(--selection-border);
  color: var(--selection);
}
.meta-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta-text + .meta-text::before {
  margin-right: 8px;
  color: var(--border-strong);
  content: "·";
}
/* On wide screens each stat is its own grid column, aligned under the sort header. */
.connection-stats {
  display: contents;
}
.stat {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stat-arrow {
  margin-right: 3px;
  font-weight: 650;
}
.stat-arrow.down {
  color: var(--chart-down);
}
.stat-arrow.up {
  color: var(--chart-up);
}
.stat-time {
  color: var(--text-muted);
}
.connection-close {
  display: flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}
.connection-close:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

/* Narrow screens keep host and route readable; traffic moves under the metadata line. */
@media (max-width: 760px) {
  .connection-row {
    grid-template-areas:
      "main close"
      "stats close";
    grid-template-columns: minmax(0, 1fr) 40px;
    gap: 4px 8px;
    padding: 9px 4px 9px 10px;
  }
  .connection-main {
    grid-area: main;
  }
  .connection-meta {
    flex-wrap: wrap;
    row-gap: 4px;
    white-space: normal;
  }
  .meta-text {
    white-space: nowrap;
  }
  .connection-stats {
    display: flex;
    grid-area: stats;
    gap: 14px;
  }
  .stat {
    text-align: left;
  }
  .connection-close {
    width: 40px;
    height: 40px;
    grid-area: close;
  }
}

@media (max-width: 480px) {
  .connection-tag {
    max-width: 100%;
  }
}
</style>
