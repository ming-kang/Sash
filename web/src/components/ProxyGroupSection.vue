<template>
  <section class="pgroup">
    <div class="pgroup-head">
      <button
        type="button"
        class="pgroup-toggle"
        :aria-expanded="!collapsed"
        @click="emit('toggle-collapse')"
      >
        <span class="pgroup-name">{{ group }}</span>
        <span class="pgroup-type">{{ typeBadge }}</span>
        <span class="pgroup-now" :title="current">{{ current }}</span>
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
      <button
        type="button"
        class="icon-btn group-action"
        :title="t('proxies.toggleGroup')"
        :aria-label="`${t('proxies.toggleGroup')}: ${group}`"
        :aria-expanded="!collapsed"
        @click.stop="emit('toggle-collapse')"
      >
        <Icon :name="collapsed ? 'eye-off' : 'eye'" :size="15" />
      </button>
    </div>
    <div v-if="!collapsed" class="pgroup-grid">
      <article
        v-for="member in visibleMembers"
        :key="member.name"
        v-memo="[member.name, member.selected, member.meta, member.udp, member.text, member.cls, member.testing, busy, selectable, locale]"
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
          :disabled="member.testing"
          @click="emit('test-node', member.name)"
        >
          <Icon v-if="member.testing" name="refresh" :size="11" class="delay-spinner" />
          <template v-else>{{ member.text }}</template>
        </button>
      </article>
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
const typeBadge = computed(() => (store.proxies[props.group]?.type ?? "S").charAt(0));
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
      testing: props.testing || (props.testingNodes?.has(name) ?? false),
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
</script>

<style scoped>
.pgroup {
  margin-bottom: 22px;
}
.pgroup-head {
  display: flex;
  min-height: 36px;
  align-items: center;
  gap: 9px;
  min-width: 0;
  margin-bottom: 7px;
  user-select: none;
}
.pgroup-toggle {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 9px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.pgroup-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 20px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pgroup-type {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: var(--radius-xs);
  background: var(--selection);
  color: var(--text-inverse);
  font-size: 12px;
  font-weight: 650;
}
.pgroup-now {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
  gap: 8px 12px;
}
.node-card {
  content-visibility: auto;
  contain-intrinsic-block-size: auto 72px;
  position: relative;
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 58px;
  grid-template-columns: minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: inherit;
  transition:
    background var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard);
}
.node-card::before {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 0;
  width: 4px;
  border-radius: 0 var(--radius-full) var(--radius-full) 0;
  background: var(--border-strong);
  content: "";
  transition: background var(--motion-fast) var(--ease-standard);
}
.node-card:hover {
  border-color: transparent;
  background: var(--bg-hover);
}
.node-card.selected {
  border-color: transparent;
  background: var(--bg-panel);
}
.node-card.selected::before {
  background: var(--selection);
}
.node-main {
  display: flex;
  min-width: 0;
  min-height: 56px;
  flex-direction: column;
  justify-content: space-between;
  padding: 8px 12px 4px 14px;
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
  min-width: 0;
}
.node-name {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 500;
  line-height: 1.4;
  white-space: normal;
}
.node-delay {
  position: absolute;
  right: 12px;
  bottom: 4px;
  display: inline-flex;
  min-width: 62px;
  min-height: 30px;
  align-items: center;
  justify-content: flex-end;
  align-self: center;
  gap: 4px;
  padding: 5px 0 5px 8px;
  border: 0;
  background: transparent;
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
}
.node-delay:hover:not(:disabled) {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.node-delay.testing {
  justify-content: center;
  color: var(--accent);
  cursor: wait;
}
.node-delay:disabled {
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
  min-height: 30px;
  margin-top: 2px;
  padding-right: 78px;
  color: var(--text-muted);
  font-size: 12px;
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
  min-height: 17px;
  align-items: center;
  padding: 0 4px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}
.spin {
  animation: rotate 0.9s linear infinite;
}

@media (max-width: 760px) {
  .group-test,
  .node-delay {
    min-width: 40px;
    min-height: 40px;
  }
  .pgroup-grid {
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
  }
  .node-sub {
    min-height: 40px;
  }
}

@media (max-width: 480px) {
  .pgroup {
    margin-bottom: 25px;
  }
  .pgroup-name {
    font-size: 20px;
  }
  .pgroup-now {
    display: none;
  }
  .pgroup-grid {
    grid-template-columns: 1fr;
  }
  .node-card,
  .node-main {
    min-height: 78px;
  }
  .node-card {
    contain-intrinsic-block-size: auto 80px;
  }
}
</style>
