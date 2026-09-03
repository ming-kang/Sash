<template>
  <section class="pgroup">
    <div class="pgroup-head">
      <span class="pgroup-name">{{ group }}</span>
      <span class="pgroup-type">{{ typeBadge }}</span>
      <span class="pgroup-now" :title="current">{{ current }}</span>
      <span class="pgroup-spacer"></span>
      <button
        type="button"
        class="icon-btn group-test"
        :title="t('proxies.testAll')"
        :aria-label="`${t('proxies.testAll')}: ${group}`"
        :disabled="testing"
        @click="emit('test-group')"
      >
        <Icon name="zap" :size="15" :class="{ spin: testing }" />
      </button>
    </div>
    <div class="pgroup-grid">
      <article
        v-for="member in members"
        :key="member"
        class="node-card"
        :class="{ selected: current === member, static: !selectable }"
      >
        <component
          :is="selectable ? 'button' : 'div'"
          class="node-main"
          :type="selectable ? 'button' : undefined"
          :aria-pressed="selectable ? current === member : undefined"
          :disabled="selectable ? busy : undefined"
          @click="selectable && !busy && emit('select', member)"
        >
          <div class="node-top">
            <span class="node-name" :title="member">{{ member }}</span>
          </div>
          <div class="node-sub">
            <span class="node-meta">
              {{ typeOf(member) }}<template v-if="isGroup(member) && nowOf(member)"> · {{ nowOf(member) }}</template>
            </span>
            <span class="node-badges">
              <span v-if="hasUdp(member)" class="node-badge udp-tag">UDP</span>
              <span
                v-if="(showCurrentTag || selectable) && current === member"
                class="node-badge node-current"
              >
                {{ t('proxies.currentTag') }}
              </span>
            </span>
          </div>
        </component>
        <button
          type="button"
          class="node-delay"
          :class="[delayClass(member), { testing: isNodeTesting(member) }]"
          :aria-label="t('proxies.testNode', { name: member })"
          :disabled="isNodeTesting(member)"
          @click="requestNodeTest(member)"
        >
          <Icon v-if="isNodeTesting(member)" name="refresh" :size="11" class="delay-spinner" />
          {{ isNodeTesting(member) ? t('common.loading') : delayText(member) }}
        </button>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n/index.js";
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
  showCurrentTag?: boolean;
}>();

const emit = defineEmits<{
  select: [name: string];
  "test-group": [];
  "test-node": [name: string];
}>();

const groupTypes = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Relay"]);
const current = computed(() => store.proxies[props.group]?.now ?? "");
const typeBadge = computed(() => (store.proxies[props.group]?.type ?? "S").charAt(0));

function nowOf(name: string): string {
  return store.proxies[name]?.now ?? "";
}

function typeOf(name: string): string {
  return store.proxies[name]?.type ?? "";
}

function isGroup(name: string): boolean {
  return groupTypes.has(typeOf(name));
}

function hasUdp(name: string): boolean {
  return store.proxies[name]?.udp ?? false;
}

function isNodeTesting(name: string): boolean {
  return props.testingNodes?.has(name) ?? false;
}

function requestNodeTest(name: string): void {
  if (!isNodeTesting(name)) emit("test-node", name);
}

function delayText(name: string): string {
  const delay = proxyDelay(name);
  if (delay === undefined) return t("common.untested");
  if (delay <= 0) return t("common.timeout");
  return `${delay} ms`;
}

function delayClass(name: string): string {
  const delay = proxyDelay(name);
  if (delay === undefined) return "delay-none";
  const level = delayLevel(delay);
  return level === "good" ? "delay-good" : level === "mid" ? "delay-mid" : "delay-bad";
}
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
}
.pgroup-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 16px;
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
  color: #ffffff;
  font-size: 10px;
  font-weight: 650;
}
.pgroup-now {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pgroup-spacer {
  flex: 1;
}
.group-test {
  color: var(--text-secondary);
}
.group-test:hover:not(:disabled) {
  color: var(--accent);
}

.pgroup-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px 12px;
}
.node-card {
  position: relative;
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 58px;
  grid-template-columns: minmax(0, 1fr) auto;
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
  justify-content: center;
  padding: 7px 7px 6px 14px;
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
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-delay {
  display: inline-flex;
  min-width: 62px;
  min-height: 30px;
  align-items: center;
  justify-content: flex-end;
  align-self: center;
  gap: 4px;
  margin-right: 12px;
  padding: 5px 0 5px 8px;
  border: 0;
  background: transparent;
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
}
.node-delay:hover:not(:disabled) {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.node-delay.testing {
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
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 10px;
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
  font-size: 8.5px;
  font-weight: 600;
  line-height: 1;
}
.node-current {
  border-color: var(--selection-border);
  color: var(--selection);
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
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  }
}

@media (max-width: 480px) {
  .pgroup {
    margin-bottom: 25px;
  }
  .pgroup-name {
    font-size: 16px;
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
}
</style>
