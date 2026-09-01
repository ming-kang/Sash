<template>
  <aside class="sidebar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="26" height="26">
          <rect width="32" height="32" rx="8" fill="var(--accent)" />
          <path
            d="M20.6 11.2c-.7-1.9-2.6-3-4.9-3-2.9 0-5 1.7-5 4 0 5.3 10.4 2.9 10.4 7.9 0 2.5-2.3 4.1-5.3 4.1-2.7 0-4.9-1.3-5.5-3.4"
            fill="none"
            stroke="white"
            stroke-width="2.6"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <div class="brand-text">
        <span class="brand-name">Sash</span>
        <span class="brand-sub">{{ t('app.subtitle') }}</span>
      </div>
    </div>

    <nav class="side-nav">
      <button
        v-for="item in navItems"
        :key="item.route"
        class="side-nav-item"
        :class="{ active: currentRoute === item.route }"
        @click="navigate(item.route)"
      >
        <Icon :name="item.icon" :size="15" />
        <span>{{ t(`nav.${item.route}`) }}</span>
      </button>
    </nav>

    <div class="side-foot">
      <div class="speed-row">
        <span class="speed-item down">
          <Icon name="arrow-down" :size="12" :stroke-width="2.4" />
          <span class="mono">{{ formatSpeed(store.traffic.down) }}</span>
        </span>
        <span class="speed-item up">
          <Icon name="arrow-up" :size="12" :stroke-width="2.4" />
          <span class="mono">{{ formatSpeed(store.traffic.up) }}</span>
        </span>
      </div>
      <div class="core-row" :title="coreTooltip">
        <span class="dot" :class="isCoreRunning ? 'dot-success' : 'dot-muted'" />
        <span class="core-label">
          {{ isCoreRunning ? t('app.coreRunning') : t('app.coreStopped') }}
        </span>
        <span v-if="coreVersion" class="core-ver mono">{{ coreVersion }}</span>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from "vue";
import Icon from "../components/Icon.vue";
import { t } from "../i18n/index.js";
import { currentRoute, navigate, type Route } from "../router.js";
import { isCoreRunning, store } from "../stores/index.js";
import { formatSpeed } from "../utils/format.js";

const navItems: Array<{ route: Route; icon: string }> = [
  { route: "overview", icon: "grid" },
  { route: "profiles", icon: "layers" },
  { route: "logs", icon: "terminal" },
  { route: "connections", icon: "swap" },
  { route: "rules", icon: "list-filter" },
  { route: "settings", icon: "settings" },
];

const coreVersion = computed(() => {
  const v = store.status?.core.version ?? store.status?.settings.coreVersion;
  return v ? (v.startsWith("v") ? v : `v${v}`) : "";
});

const coreTooltip = computed(() =>
  store.status?.core.pid ? `PID ${store.status.core.pid}` : "",
);
</script>

<style scoped>
.sidebar {
  width: var(--sidebar-w);
  flex-shrink: 0;
  background: var(--bg-card);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 0;
  height: 100vh;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 18px 14px;
}
.brand-mark {
  display: flex;
}
.brand-mark svg {
  display: block;
  border-radius: 7px;
}
.brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.brand-name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.2;
}
.brand-sub {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.3;
  white-space: nowrap;
}

.side-nav {
  flex: 1;
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}
.side-nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.side-nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.side-nav-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.side-foot {
  border-top: 1px solid var(--border);
  padding: 12px 18px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.speed-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.speed-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 600;
}
.speed-item.down {
  color: var(--chart-down);
}
.speed-item.up {
  color: var(--chart-up);
}
.core-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-secondary);
}
.core-label {
  font-weight: 500;
}
.core-ver {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
}

@media (max-width: 900px) {
  .sidebar {
    width: 100%;
    height: auto;
    position: static;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .brand {
    padding: 12px 16px 8px;
  }
  .side-nav {
    flex-direction: row;
    overflow-x: auto;
    padding: 0 10px 8px;
  }
  .side-nav-item {
    flex-shrink: 0;
  }
  .side-foot {
    display: none;
  }
}
</style>
