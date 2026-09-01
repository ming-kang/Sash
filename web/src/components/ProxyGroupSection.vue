<template>
  <section class="pgroup">
    <div class="pgroup-head">
      <span class="pgroup-name">{{ group }}</span>
      <span class="pgroup-type">{{ typeBadge }}</span>
      <span class="pgroup-now" :title="current">{{ current }}</span>
      <span class="pgroup-spacer"></span>
      <button
        class="icon-btn"
        :class="{ spin: testing }"
        :title="t('proxies.testAll')"
        :disabled="testing"
        @click="emit('test-group')"
      >
        <Icon name="zap" :size="13" />
      </button>
    </div>
    <div class="pgroup-grid">
      <component
        :is="selectable ? 'button' : 'div'"
        v-for="member in members"
        :key="member"
        class="node-card"
        :class="{ selected: current === member, static: !selectable }"
        @click="selectable && emit('select', member)"
      >
        <div class="node-top">
          <span class="node-name" :title="member">{{ member }}</span>
          <span class="node-delay" :class="delayClass(member)" @click.stop="emit('test-node', member)">
            {{ delayText(member) }}
          </span>
        </div>
        <div class="node-sub">
          {{ typeOf(member) }}<template v-if="isGroup(member) && nowOf(member)"> · {{ nowOf(member) }}</template>
          <span v-if="hasUdp(member)" class="udp-tag">UDP</span>
          <span v-if="showCurrentTag && current === member" class="node-current">
            {{ t('proxies.currentTag') }}
          </span>
        </div>
      </component>
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
  margin-bottom: 14px;
}
.pgroup-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.pgroup-name {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text-primary);
}
.pgroup-type {
  font-size: 10px;
  font-weight: 700;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 4px;
  padding: 1px 5px;
  line-height: 1.5;
}
.pgroup-now {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pgroup-spacer {
  flex: 1;
}
.pgroup-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}
.node-card {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease,
    transform 0.12s ease;
}
button.node-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-card);
}
.node-card.selected {
  border-color: var(--border-accent);
  box-shadow: inset 2px 0 0 var(--accent);
}
.node-card.static {
  cursor: default;
}
.node-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.node-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-delay {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
  cursor: pointer;
}
.node-delay:hover {
  text-decoration: underline dotted;
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
}
.node-sub {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-current {
  color: var(--accent);
  font-weight: 600;
  margin-left: 4px;
}
.udp-tag {
  display: inline-block;
  font-size: 9.5px;
  font-weight: 600;
  color: var(--text-secondary);
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  padding: 0 4px;
  margin-left: 4px;
  line-height: 1.5;
  vertical-align: 1px;
}
.spin {
  animation: rotate 0.9s linear infinite;
}
</style>
