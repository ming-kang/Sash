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
        <Icon name="zap" :size="14" :class="{ spin: testing }" />
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
  margin-bottom: 18px;
}
.pgroup-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-bottom: 9px;
}
.pgroup-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13.5px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pgroup-type {
  flex-shrink: 0;
  padding: 1px 6px;
  border: 1px solid var(--border-accent);
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.5;
}
.pgroup-now {
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pgroup-spacer {
  flex: 1;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  color: var(--text-secondary);
  cursor: pointer;
}
.icon-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-hover);
  color: var(--accent);
}
.icon-btn:focus-visible,
.node-main:focus-visible,
.node-delay:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-ring);
}
.icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pgroup-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 9px;
}
.node-card {
  position: relative;
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 70px;
  grid-template-columns: minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-card);
  color: inherit;
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease,
    transform 0.12s ease;
}
.node-card::before {
  position: absolute;
  top: 0;
  right: 10px;
  left: 10px;
  height: 2px;
  border-radius: 0 0 999px 999px;
  background: transparent;
  content: "";
}
.node-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-card);
  transform: translateY(-1px);
}
.node-card.selected {
  border-color: var(--border-accent);
  background: var(--bg-active);
  box-shadow: 0 0 0 1px var(--accent-ring), var(--shadow-card);
}
.node-card.selected::before {
  background: var(--accent);
  box-shadow: 0 2px 8px var(--accent-ring);
}
.node-main {
  display: flex;
  min-width: 0;
  min-height: 68px;
  flex-direction: column;
  justify-content: center;
  padding: 11px 6px 9px 12px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.node-main:disabled {
  cursor: wait;
  opacity: 0.7;
}
.node-card.static .node-main {
  cursor: default;
}
.node-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.node-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-delay {
  display: inline-flex;
  min-width: 58px;
  min-height: 24px;
  align-items: center;
  justify-content: center;
  align-self: start;
  margin: 10px 12px 0 0;
  padding: 2px 8px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 650;
  line-height: 1;
  cursor: pointer;
}
.node-delay:hover {
  background: var(--bg-hover);
}
.node-delay.testing {
  color: var(--accent);
  cursor: wait;
}
.node-delay:disabled {
  opacity: 0.72;
}
.delay-spinner {
  margin-right: 4px;
  animation: rotate 0.9s linear infinite;
}
.delay-good {
  color: var(--success);
  background: var(--success-soft);
}
.delay-mid {
  color: var(--warning);
  background: var(--warning-soft);
}
.delay-bad {
  color: var(--danger);
  background: var(--danger-soft);
}
.delay-none {
  color: var(--text-muted);
}
.node-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-top: 7px;
  color: var(--text-muted);
  font-size: 10.5px;
}
.node-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-badges {
  display: inline-flex;
  gap: 4px;
  flex-shrink: 0;
  margin-left: auto;
}
.node-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 5px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--bg-inset);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
}
.node-current {
  border-color: var(--border-accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.udp-tag {
  color: var(--text-secondary);
}
.spin {
  animation: rotate 0.9s linear infinite;
}

@media (max-width: 760px) {
  .icon-btn,
  .node-delay {
    min-width: 40px;
    min-height: 40px;
  }
  .pgroup-grid {
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  }
}

@media (max-width: 480px) {
  .pgroup-head {
    gap: 6px;
  }
  .pgroup-now {
    display: none;
  }
  .pgroup-grid {
    grid-template-columns: 1fr;
  }
  .node-card,
  .node-main {
    min-height: 76px;
  }
}
</style>
