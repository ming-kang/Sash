<template>
  <aside class="sidebar">
    <div class="traffic-panel" aria-live="off">
      <div class="traffic-row up" :title="t('overview.upload')">
        <span class="traffic-arrow">↑</span>
        <span class="traffic-number mono">{{ uploadSpeed.numberText }}</span>
        <span class="traffic-unit mono">{{ uploadSpeed.unitText }}</span>
      </div>
      <div class="traffic-row down" :title="t('overview.download')">
        <span class="traffic-arrow">↓</span>
        <span class="traffic-number mono">{{ downloadSpeed.numberText }}</span>
        <span class="traffic-unit mono">{{ downloadSpeed.unitText }}</span>
      </div>
    </div>

    <nav class="side-nav" :aria-label="t('app.navigation')">
      <button
        v-for="(item, index) in navItems"
        :key="item.route"
        type="button"
        class="side-nav-item"
        :class="navItemClasses(index)"
        :aria-current="currentRoute === item.route ? 'page' : undefined"
        @click="navigate(item.route)"
      >
        <span class="nav-icon"><Icon :name="item.icon" :size="19" /></span>
        <span class="nav-label">{{ t(`nav.${item.route}`) }}</span>
      </button>
    </nav>

    <div class="side-foot">
      <div class="runtime mono">{{ uptime }}</div>
      <div class="core-row" :title="coreTooltip">
        <span class="dot" :class="isCoreRunning ? 'dot-success' : 'dot-muted'" />
        <span class="core-label">
          {{ isCoreRunning ? t('common.running') : t('common.stopped') }}
        </span>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { t } from "../i18n/index.js";
import { currentRoute, navigate, type Route } from "../router.js";
import { isCoreRunning, store } from "../stores/index.js";
import Icon from "./Icon.vue";

interface TrafficSpeedDisplay {
  numberText: string;
  unitText: string;
}

function formatTrafficSpeed(bytesPerSecond: number): TrafficSpeedDisplay {
  const normalizedSpeed = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0;
  const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
  if (normalizedSpeed < 1024) {
    return { numberText: Math.round(normalizedSpeed).toString(), unitText: units[0] ?? "B/s" };
  }

  const unitIndex = Math.min(
    Math.floor(Math.log(normalizedSpeed) / Math.log(1024)),
    units.length - 1,
  );
  return {
    numberText: (normalizedSpeed / 1024 ** unitIndex).toFixed(2),
    unitText: units[unitIndex] ?? "B/s",
  };
}

const navItems: Array<{ route: Route; icon: string }> = [
  { route: "overview", icon: "grid" },
  { route: "profiles", icon: "layers" },
  { route: "logs", icon: "terminal" },
  { route: "connections", icon: "swap" },
  { route: "rules", icon: "list-filter" },
  { route: "settings", icon: "settings" },
];

function formatRuntimeClock(startedAt: string | undefined, currentTime: number): string {
  if (!startedAt) return "00 : 00 : 00";
  const startedAtMilliseconds = new Date(startedAt).getTime();
  if (!Number.isFinite(startedAtMilliseconds)) return "00 : 00 : 00";

  const totalSeconds = Math.max(0, Math.floor((currentTime - startedAtMilliseconds) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const padTimePart = (value: number): string => value.toString().padStart(2, "0");
  return `${padTimePart(hours)} : ${padTimePart(minutes)} : ${padTimePart(seconds)}`;
}

const currentTime = ref(Date.now());
let clockTimer: number | null = null;

const activeIndex = computed(() => navItems.findIndex((item) => item.route === currentRoute.value));
const uploadSpeed = computed(() => formatTrafficSpeed(store.traffic.up));
const downloadSpeed = computed(() => formatTrafficSpeed(store.traffic.down));
const uptime = computed(() => formatRuntimeClock(store.status?.core.startedAt, currentTime.value));
const coreTooltip = computed(() => {
  const status = isCoreRunning.value ? t("app.coreRunning") : t("app.coreStopped");
  return store.status?.core.pid ? `${status} · PID ${store.status.core.pid}` : status;
});

onMounted(() => {
  clockTimer = window.setInterval(() => {
    currentTime.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  if (clockTimer !== null) window.clearInterval(clockTimer);
});

function navItemClasses(index: number): Record<string, boolean> {
  return {
    active: activeIndex.value === index,
    "before-active": activeIndex.value === index + 1,
    "after-active": activeIndex.value === index - 1,
  };
}
</script>

<style scoped>
.sidebar {
  position: relative;
  z-index: 20;
  display: flex;
  width: var(--sidebar-w);
  height: 100%;
  flex-shrink: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-sidebar);
}
.traffic-panel {
  display: flex;
  height: 80px;
  align-items: center;
  flex-shrink: 0;
  flex-direction: column;
  justify-content: center;
  gap: 12px;
  padding: 0;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border);
}
.traffic-row {
  display: grid;
  width: 122px;
  grid-template-columns: 14px 58px 42px;
  align-items: baseline;
  column-gap: 4px;
  color: var(--text-primary);
  font-size: 10.5px;
  line-height: 1;
}
.traffic-arrow {
  text-align: center;
  font-size: 12px;
}
.traffic-number {
  overflow: hidden;
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.traffic-unit {
  overflow: hidden;
  text-align: left;
  white-space: nowrap;
}
.side-nav {
  display: flex;
  height: 360px;
  flex-shrink: 0;
  flex-direction: column;
  background: var(--bg-app);
  border-bottom: 1px solid var(--border);
}
.side-nav-item {
  display: flex;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 0 18px;
  border: 0;
  border-radius: 0;
  background: var(--bg-sidebar);
  color: var(--menu-text);
  cursor: pointer;
  font-size: 15px;
  text-align: center;
  transition:
    background var(--motion-normal) var(--ease-standard),
    color var(--motion-normal) var(--ease-standard);
}
.side-nav-item:hover {
  color: var(--text-primary);
}
.side-nav-item.active {
  background: var(--bg-app);
  color: var(--text-primary);
}
.side-nav-item.before-active {
  border-bottom-right-radius: 10px;
}
.side-nav-item.after-active {
  border-top-right-radius: 10px;
}
.nav-icon {
  display: none;
}
.nav-label {
  width: 100%;
  overflow: hidden;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-foot {
  display: flex;
  min-height: 0;
  flex: 1;
  align-items: center;
  flex-direction: column;
  justify-content: flex-end;
  padding: 16px 12px 0;
  background: var(--bg-sidebar);
}
.runtime {
  width: 128px;
  margin-bottom: 14px;
  color: var(--text-primary);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  text-align: center;
  white-space: nowrap;
}
.core-row {
  display: flex;
  width: 100%;
  height: 40px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--text-primary);
  font-size: 11px;
}
.core-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 899px) {
  .sidebar {
    position: static;
    width: 100%;
    height: 0;
    overflow: visible;
  }
  .traffic-panel,
  .side-foot {
    display: none;
  }
  .side-nav {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 40;
    display: grid;
    height: calc(62px + env(safe-area-inset-bottom));
    grid-template-columns: repeat(6, minmax(0, 1fr));
    padding: 5px 4px calc(5px + env(safe-area-inset-bottom));
    background: var(--bg-sidebar);
    border-top: 1px solid var(--border);
    border-bottom: 0;
    box-shadow: var(--shadow-nav);
  }
  .side-nav-item,
  .side-nav-item.active,
  .side-nav-item.before-active,
  .side-nav-item.after-active {
    min-height: 50px;
    justify-content: center;
    flex-direction: column;
    gap: 2px;
    padding: 4px 1px;
    border-radius: 5px;
    background: transparent;
    font-size: 9px;
  }
  .side-nav-item.active {
    background: var(--bg-active);
  }
  .nav-icon {
    display: flex;
  }
  .nav-label {
    font-size: 9px;
  }
}
</style>
