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
      >
        <article
          v-for="member in batch"
          :key="member.name"
          v-memo="[member.name, member.selected, member.meta, member.udp, member.text, member.cls, member.testing, member.pending, busy, selectable, testing, locale]"
          class="node-card"
          :class="{ selected: member.selected, static: !selectable }"
        >
          <component
            :is="selectable ? 'button' : 'div'"
            class="node-main"
            :type="selectable ? 'button' : undefined"
            :aria-pressed="selectable ? member.selected : undefined"
            :disabled="selectable ? busy : undefined"
            @click="selectable && !busy && emit('select', member.name)"
          >
            <div class="node-top">
              <span class="node-name" :title="member.name">{{ member.name }}</span>
              <Icon v-if="member.selected" name="check-circle" :size="14" class="node-selected" />
              <Icon v-if="member.pending" name="loader" :size="12" class="spin node-pending" />
            </div>
            <div class="node-sub">
              <span class="node-meta">
                {{ member.meta }}
              </span>
              <span class="node-badges">
                <span v-if="member.udp" class="node-badge udp-tag">UDP</span>
              </span>
            </div>
          </component>
          <button
            type="button"
            class="node-delay"
            :class="[member.cls, { testing: member.testing }]"
            :aria-label="`${t('proxies.testNode', { name: member.name })}: ${member.text}`"
            :disabled="member.testing || testing"
            @click="emit('test-node', member.name)"
          >
            <Icon v-if="member.testing" name="refresh" :size="11" class="delay-spinner" />
            <span v-else class="node-delay-text">{{ member.text }}</span>
          </button>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { locale, t } from "../i18n/index.js";
import { proxyDelay, store } from "../stores/index.js";
import { delayLevel } from "../utils/format.js";
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
const hasDelays = computed(() => props.members.some((name) => proxyDelay(name) !== undefined));

const visibleMembers = computed(() => {
  const members = props.members.map((name) => {
    const proxy = store.proxies[name];
    const delay = proxyDelay(name);
    const level = typeof delay === "number" ? delayLevel(delay) : "bad";
    return {
      name,
      selected: current.value === name,
      meta: `${proxy?.type ?? ""}${groupTypes.has(proxy?.type ?? "") && proxy?.now ? ` · ${proxy.now}` : ""}`,
      udp: proxy?.udp ?? false,
      pending: props.pending === name,
      testing: props.testingNodes?.has(name) ?? false,
      timeout: delay === 0,
      rank: typeof delay === "number" && delay > 0 ? delay : Number.POSITIVE_INFINITY,
      cls: delay === undefined ? "delay-none" : `delay-${level}`,
      text: delay === undefined ? t("common.untested")
        : delay === "failed" ? t("common.failed")
        : delay <= 0 ? t("common.timeout") : `${delay} ms`,
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
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 210px), 1fr));
  gap: 12px;
}
.node-batch {
  display: grid;
  min-width: 0;
  grid-column: 1 / -1;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 210px), 1fr));
  gap: 12px;
  content-visibility: auto;
  contain-intrinsic-block-size: auto 640px;
}
.node-card {
  position: relative;
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 64px;
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
  background: var(--bg-hover);
}
.node-card.selected,
.node-card.selected:hover {
  border-color: var(--selection-border);
  background: var(--selection-soft);
}
.node-main {
  display: flex;
  min-width: 0;
  min-height: 62px;
  flex-direction: column;
  justify-content: space-between;
  padding: 10px 12px 5px;
  border: 0;
  background: transparent;
  color: inherit;
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
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.node-pending {
  flex-shrink: 0;
  color: var(--accent);
}
.node-selected {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--selection);
}
.node-name {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 550;
  line-height: 1.4;
  white-space: normal;
}
.node-delay {
  position: absolute;
  right: 9px;
  bottom: 5px;
  display: inline-flex;
  min-width: 60px;
  height: 28px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 7px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 550;
  line-height: 1;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard);
}
.node-delay-text {
  display: block;
  line-height: 1;
  white-space: nowrap;
}
.node-delay:hover:not(:disabled) {
  background: var(--bg-inset);
}
.node-delay.testing {
  justify-content: center;
  color: var(--accent);
  cursor: wait;
  opacity: 0.72;
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
  color: var(--text-secondary);
}
.node-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 28px;
  margin-top: 3px;
  padding-right: 70px;
  color: var(--text-muted);
  font-size: 11px;
}
.node-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-badges {
  display: inline-flex;
  flex-shrink: 0;
  gap: 4px;
  margin-left: auto;
}
.node-badge {
  display: inline-flex;
  height: 18px;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}
.spin {
  animation: rotate 0.9s linear infinite;
}

@media (max-width: 760px) {
  .group-action,
  .group-test,
  .node-delay {
    min-width: 40px;
  }
  .node-delay {
    height: 40px;
  }
  .node-sub {
    min-height: 40px;
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
  }
  .node-batch {
    contain-intrinsic-block-size: auto 2100px;
  }
  .node-card,
  .node-main {
    min-height: 78px;
  }
}
</style>
