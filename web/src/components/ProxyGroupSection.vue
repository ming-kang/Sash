<template>
  <section class="pgroup">
    <div class="pgroup-head">
      <button
        type="button"
        class="pgroup-toggle"
        :aria-expanded="!collapsed"
        @click="emit('toggle-collapse')"
      >
        <Icon
          name="chevron-down"
          :size="16"
          class="pgroup-chevron"
          :class="{ collapsed }"
        />
        <span class="pgroup-name">{{ group }}</span>
        <span class="pgroup-type">{{ typeBadge }}</span>
      </button>
      <button
        type="button"
        class="icon-btn group-action"
        :class="{ active: sortByLatency }"
        :title="t('proxies.sortLatency')"
        :aria-label="t('proxies.sortLatency')"
        :aria-pressed="sortByLatency"
        :disabled="!hasDelays"
        @click="sortByLatency = !sortByLatency"
      >
        <Icon name="list-filter" :size="15" />
      </button>
      <button
        type="button"
        class="icon-btn group-action"
        :class="{ active: hideTimeout }"
        :title="t('proxies.hideTimeout')"
        :aria-label="t('proxies.hideTimeout')"
        :aria-pressed="hideTimeout ?? false"
        @click.stop="emit('toggle-hide-timeout')"
      >
        <Icon name="timer" :size="15" />
      </button>
      <button
        type="button"
        class="icon-btn group-test"
        :title="t('proxies.testAll')"
        :aria-label="`${t('proxies.testAll')}: ${group}`"
        :disabled="testing || members.some((name) => testingNodes?.has(name))"
        @click.stop="emit('test-group')"
      >
        <Icon :name="testing ? 'loader' : 'zap'" :size="15" :class="{ spin: testing }" />
      </button>
    </div>
    <div v-if="!collapsed" class="pgroup-grid">
      <div
        v-for="batch in visibleMemberBatches"
        :key="batch[0]?.name"
        class="node-batch"
        :style="{ '--batch-size': batch.length }"
      >
        <article
          v-for="member in batch"
          :key="member.name"
          v-memo="[member.name, member.selected, member.type, member.udp, member.via, member.viaRegion, member.title, member.text, member.cls, member.testing, member.pending, busy, selectable, testing, locale]"
          class="node-card"
          :class="{ selected: member.selected, static: !selectable }"
        >
          <component
            :is="selectable ? 'button' : 'div'"
            class="node-main"
            :type="selectable ? 'button' : undefined"
            :title="member.title"
            :aria-pressed="selectable ? member.selected : undefined"
            :disabled="selectable ? busy : undefined"
            @click="selectable && !busy && emit('select', member.name)"
          >
            <span class="node-top">
              <span class="node-name"><span v-if="member.region" class="region-code">{{ member.region }}</span>{{ member.label }}</span>
              <Icon v-if="member.pending" name="loader" :size="12" class="spin node-pending" />
            </span>
            <span class="node-meta">
              <span class="node-type">{{ member.type }}</span>
              <template v-if="member.via">
                <span class="meta-sep" aria-hidden="true" />
                <span class="node-via">
                  <span aria-hidden="true">→</span>
                  <span v-if="member.viaRegion" class="region-code">{{ member.viaRegion }}</span>
                  <span class="node-via-name">{{ member.via }}</span>
                </span>
              </template>
              <template v-else-if="member.udp">
                <span class="meta-sep" aria-hidden="true" />
                <span>UDP</span>
              </template>
            </span>
          </component>
          <button
            type="button"
            class="node-delay"
            :class="[member.cls, { testing: member.testing }]"
            :aria-label="`${t('proxies.testNode', { name: member.name })}: ${member.status}`"
            :disabled="member.testing || testing"
            @click="emit('test-node', member.name)"
          >
            <Icon v-if="member.testing" name="refresh" :size="12" class="delay-spinner" />
            <span v-else-if="member.ms !== undefined">{{ member.ms }}<small>ms</small></span>
            <template v-else>{{ member.text }}</template>
          </button>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { locale, t } from "../i18n/index.js";
import { proxyChain, resolvedProxyDelay, store } from "../stores/index.js";
import { delayLevel, splitRegionFlag } from "../utils/format.js";
import Icon from "./Icon.vue";

const props = defineProps<{
  group: string;
  members: string[];
  selectable: boolean;
  testing: boolean;
  testingNodes?: ReadonlySet<string>;
  busy?: boolean;
  pending?: string;
  collapsed?: boolean;
  hideTimeout?: boolean;
}>();

const emit = defineEmits<{
  select: [name: string];
  "test-group": [];
  "test-node": [name: string];
  "toggle-collapse": [];
  "toggle-hide-timeout": [];
}>();

const groupTypes = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Relay"]);
const current = computed(() => store.proxies[props.group]?.now ?? "");
const typeBadge = computed(() => store.proxies[props.group]?.type ?? "Selector");
const sortByLatency = ref(false);
const hasDelays = computed(() =>
  props.members.some((name) => resolvedProxyDelay(name) !== undefined),
);

const visibleMembers = computed(() => {
  const members = props.members.map((name) => {
    const proxy = store.proxies[name];
    const isGroup = groupTypes.has(proxy?.type ?? "") || Array.isArray(proxy?.all);
    const chain = isGroup ? proxyChain(name) : [name];
    const routed = chain.length > 1 ? (chain.at(-1) ?? "") : "";
    const delay = resolvedProxyDelay(name);
    const { region, label } = splitRegionFlag(name);
    const via = splitRegionFlag(routed);
    const status = delay === undefined ? t("common.untested")
      : delay === "failed" ? t("common.failed")
      : delay <= 0 ? t("common.timeout") : `${delay} ms`;
    return {
      name,
      region,
      label,
      title: chain.join(" → "),
      selected: current.value === name,
      type: proxy?.type ?? "",
      udp: !isGroup && (proxy?.udp ?? false),
      via: via.label,
      viaRegion: via.region,
      pending: props.pending === name,
      testing: chain.some((node) => props.testingNodes?.has(node)),
      timeout: delay === 0,
      rank: typeof delay === "number" && delay > 0 ? delay : Number.POSITIVE_INFINITY,
      cls: typeof delay === "number" ? `delay-${delayLevel(delay)}`
        : delay === "failed" ? "delay-bad" : "delay-none",
      ms: typeof delay === "number" && delay > 0 ? delay : undefined,
      // Untested stays a quiet dash; the accessible label still spells it out.
      text: delay === undefined ? "—" : status,
      status,
    };
  }).filter((member) => !props.hideTimeout || !member.timeout);
  // Stable sorting leaves equal, failed and untested entries in source order.
  return sortByLatency.value ? members.sort((a, b) => a.rank - b.rank) : members;
});

const NODE_BATCH_SIZE = 24;
const visibleMemberBatches = computed(() => {
  const batches = [];
  for (let index = 0; index < visibleMembers.value.length; index += NODE_BATCH_SIZE) {
    batches.push(visibleMembers.value.slice(index, index + NODE_BATCH_SIZE));
  }
  return batches;
});
</script>

<style scoped>
.pgroup {
  margin-bottom: 22px;
}
.pgroup-head {
  display: flex;
  min-height: 38px;
  align-items: center;
  gap: 4px;
  min-width: 0;
  margin-bottom: 9px;
  user-select: none;
}
.pgroup-toggle {
  display: flex;
  min-width: 0;
  min-height: 34px;
  flex: 1;
  align-items: center;
  gap: 8px;
  margin-left: -5px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.pgroup-toggle:hover {
  background: var(--bg-hover);
}
.pgroup-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform var(--motion-normal) var(--ease-standard);
}
.pgroup-chevron.collapsed {
  transform: rotate(-90deg);
}
.pgroup-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pgroup-type {
  display: inline-flex;
  min-height: 20px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--bg-inset);
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.group-test {
  color: var(--text-secondary);
}
.group-test:hover:not(:disabled) {
  color: var(--accent);
}
.group-action {
  color: var(--text-secondary);
}
.group-action:hover:not(:disabled) {
  color: var(--accent);
}
.group-action.active {
  color: var(--accent);
  background: var(--accent-soft);
}

.pgroup-grid {
  display: grid;
  container-type: inline-size;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
  gap: 10px;
}
.node-batch {
  display: grid;
  min-width: 0;
  grid-column: 1 / -1;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
  gap: 10px;
  content-visibility: auto;
  /* Placeholder height before first paint, scaled to the batch so short groups do not reserve
     a full batch of space. Assumes about three columns; the single-column query refines it. */
  contain-intrinsic-block-size: auto calc(var(--batch-size, 24) * 24px);
}
.node-card {
  position: relative;
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-card);
  color: inherit;
  transition:
    background var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard);
}
.node-card:hover {
  border-color: var(--border-strong);
}
.node-card.selected,
.node-card.selected:hover {
  border-color: var(--selection-border);
  background: var(--selection-soft);
}
.node-card.selected::before {
  position: absolute;
  top: 10px;
  bottom: 10px;
  left: 0;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--selection);
  content: "";
}
.node-main {
  display: flex;
  min-width: 0;
  min-height: 58px;
  flex-direction: column;
  justify-content: space-between;
  gap: 5px;
  padding: 9px 12px 9px 13px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.node-main:disabled {
  cursor: wait;
  opacity: 0.68;
}
/* The card clips overflowing content, so the focus outline must be inset
   instead of using the global positive offset. */
.node-main:focus-visible {
  outline-offset: -2px;
}
.node-card.static .node-main {
  cursor: default;
}
.node-top {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 6px;
  /* Room for the delay button, which sits over the card's top-right corner. */
  padding-right: 58px;
}
/* One line in multi-column grids keeps rows even; the full name is in the card's title. */
.node-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13.5px;
  font-weight: 560;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.region-code {
  display: inline-block;
  margin-right: 6px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--bg-inset);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
  vertical-align: 1px;
}
.node-pending {
  flex-shrink: 0;
  margin-top: 4px;
  color: var(--accent);
}
.node-meta {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 16px;
  white-space: nowrap;
}
.node-type {
  flex-shrink: 0;
}
.meta-sep {
  width: 3px;
  height: 3px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: currentColor;
  opacity: 0.55;
}
.node-via {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
}
.node-via .region-code {
  margin-right: 0;
  font-size: 9px;
  line-height: 13px;
}
.node-via-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.node-delay {
  position: absolute;
  top: 7px;
  right: 7px;
  display: inline-flex;
  min-width: 34px;
  height: 24px;
  align-items: center;
  justify-content: flex-end;
  padding: 0 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard);
}
.node-delay small {
  margin-left: 1px;
  font-size: 10px;
  font-weight: 500;
  opacity: 0.75;
}
/* Hovering the card hints that the delay is its own retest button. */
.node-card:hover .node-delay:not(:disabled) {
  background: var(--bg-inset);
}
.node-card .node-delay:hover:not(:disabled) {
  background: var(--bg-active);
}
.node-delay.testing {
  justify-content: center;
  color: var(--accent);
  cursor: wait;
}
.delay-spinner {
  animation: rotate 0.9s linear infinite;
}
.delay-good {
  color: var(--success);
}
.delay-mid {
  color: var(--warning);
}
.delay-bad {
  color: var(--danger);
}
.delay-none {
  color: var(--text-muted);
  font-weight: 500;
}
.spin {
  animation: rotate 0.9s linear infinite;
}

/* A single column has room to grow vertically, so long names get a second line. */
@container (max-width: 449px) {
  .node-name {
    display: -webkit-box;
    overflow-wrap: anywhere;
    white-space: normal;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .node-batch {
    contain-intrinsic-block-size: auto calc(var(--batch-size, 24) * 70px);
  }
}

@media (max-width: 760px) {
  .group-action,
  .group-test {
    min-width: 40px;
  }
  .node-delay {
    top: 4px;
    right: 4px;
    min-width: 44px;
    height: 36px;
    padding: 0 9px;
  }
  .node-top {
    padding-right: 62px;
  }
  .node-main {
    min-height: 62px;
    padding-block: 11px;
  }
}

@media (max-width: 480px) {
  .pgroup {
    margin-bottom: 25px;
  }
  .pgroup-type {
    display: none;
  }
  .pgroup-grid,
  .node-batch {
    grid-template-columns: 1fr;
    gap: 8px;
  }
}
</style>
