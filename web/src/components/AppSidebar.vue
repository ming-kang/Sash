<template>
  <aside class="sidebar">
    <div class="brand-row">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 36 36">
          <rect width="36" height="36" rx="8" fill="var(--general-title)" />
          <path
            d="M23 12.6c-.8-2.1-2.9-3.3-5.5-3.3-3.2 0-5.6 1.9-5.6 4.5 0 5.9 11.7 3.2 11.7 8.8 0 2.8-2.6 4.6-6 4.6-3 0-5.5-1.5-6.2-3.8"
            fill="none"
            stroke="var(--bg-app)"
            stroke-width="2.8"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <div class="brand-text">
        <span class="brand-name">Sash</span>
        <span class="brand-sub">{{ t('app.subtitle') }}</span>
      </div>

      <button
        type="button"
        class="theme-button mobile-theme"
        :aria-label="themeButtonLabel"
        :title="themeTitle"
        @click="cycleTheme"
      >
        <Icon :name="themeIcon" :size="17" />
      </button>
    </div>

    <div class="traffic-panel" aria-live="off">
      <div class="traffic-row down" :title="t('overview.download')">
        <span class="traffic-arrow">↓</span>
        <span class="traffic-value mono">{{ formatSpeed(store.traffic.down) }}</span>
      </div>
      <div class="traffic-row up" :title="t('overview.upload')">
        <span class="traffic-arrow">↑</span>
        <span class="traffic-value mono">{{ formatSpeed(store.traffic.up) }}</span>
      </div>
    </div>

    <nav class="side-nav" :aria-label="t('app.navigation')">
      <button
        v-for="item in navItems"
        :key="item.route"
        type="button"
        class="side-nav-item"
        :class="{ active: currentRoute === item.route }"
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
      <div v-if="coreVersion" class="core-version mono">{{ coreVersion }}</div>
      <button
        type="button"
        class="theme-button desktop-theme"
        :aria-label="themeButtonLabel"
        :title="themeTitle"
        @click="cycleTheme"
      >
        <Icon :name="themeIcon" :size="16" />
        <span>{{ themeName }}</span>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { coreVersion } from "../composables/core-runtime.js";
import { locale, t } from "../i18n/index.js";
import { currentRoute, navigate, type Route } from "../router.js";
import { isCoreRunning, store } from "../stores/index.js";
import { cycleTheme, theme } from "../theme.js";
import { formatDuration, formatSpeed } from "../utils/format.js";
import Icon from "./Icon.vue";

const navItems: Array<{ route: Route; icon: string }> = [
  { route: "overview", icon: "grid" },
  { route: "profiles", icon: "layers" },
  { route: "logs", icon: "terminal" },
  { route: "connections", icon: "swap" },
  { route: "rules", icon: "list-filter" },
  { route: "settings", icon: "settings" },
];

const uptime = computed(() => formatDuration(store.status?.core.startedAt, locale.value));
const coreTooltip = computed(() => {
  const status = isCoreRunning.value ? t("app.coreRunning") : t("app.coreStopped");
  return store.status?.core.pid ? `${status} · PID ${store.status.core.pid}` : status;
});
const themeName = computed(() => t(`theme.${theme.value}`));
const themeIcon = computed(() => {
  if (theme.value === "light") return "sun";
  if (theme.value === "dark") return "moon";
  return "monitor";
});
const themeTitle = computed(() => t("theme.current", { theme: themeName.value }));
const themeButtonLabel = computed(() => `${t("theme.switch")}. ${themeTitle.value}`);
</script>

<style scoped>
.sidebar {
  --general-title: #2c3e50;
  position: relative;
  z-index: 20;
  display: flex;
  width: var(--sidebar-w);
  height: 100vh;
  height: 100dvh;
  flex-shrink: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
}
:global(html[data-theme="dark"]) .sidebar {
  --general-title: #d9d6dd;
}

.brand-row {
  display: flex;
  min-height: 62px;
  align-items: center;
  gap: 10px;
  padding: 11px 18px;
  border-bottom: 1px solid var(--border);
}
.brand-mark,
.brand-mark svg {
  display: block;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
}
.brand-text {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.brand-name {
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.01em;
  line-height: 1.2;
}
.brand-sub {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 9.5px;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.traffic-panel {
  display: grid;
  min-height: 86px;
  align-content: center;
  gap: 9px;
  padding: 12px 22px;
  border-bottom: 1px solid var(--border);
}
.traffic-row {
  display: grid;
  min-width: 0;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: baseline;
  gap: 8px;
  color: var(--text-primary);
  font-size: 12px;
}
.traffic-arrow {
  color: var(--text-secondary);
  font-size: 15px;
  line-height: 1;
  text-align: center;
}
.traffic-value {
  overflow: hidden;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side-nav {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  padding: 10px 0;
  overflow-y: auto;
}
.side-nav-item {
  position: relative;
  display: flex;
  width: calc(100% - 10px);
  min-height: 50px;
  align-items: center;
  gap: 10px;
  padding: 0 22px;
  border: 0;
  border-radius: 0 var(--radius-xl) var(--radius-xl) 0;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 15px;
  text-align: left;
  transition:
    background var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}
.side-nav-item::before {
  position: absolute;
  top: 14px;
  bottom: 14px;
  left: 0;
  width: 3px;
  border-radius: 0 var(--radius-full) var(--radius-full) 0;
  background: var(--accent);
  content: "";
  opacity: 0;
}
.side-nav-item:hover {
  background: color-mix(in srgb, var(--bg-app) 62%, transparent);
  color: var(--text-primary);
}
.side-nav-item.active {
  background: var(--bg-app);
  color: var(--text-primary);
}
.side-nav-item.active::before {
  opacity: 1;
}
.nav-icon {
  display: none;
}
.nav-label {
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side-foot {
  display: flex;
  min-height: 142px;
  flex-direction: column;
  justify-content: center;
  padding: 17px 22px max(16px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--border);
}
.runtime {
  margin-bottom: 13px;
  color: var(--text-primary);
  font-size: 17px;
  font-variant-numeric: tabular-nums;
}
.core-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
  font-size: 12.5px;
}
.core-label,
.core-version {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.core-version {
  margin: 3px 0 12px 15px;
  color: var(--text-muted);
  font-size: 9.5px;
}
.theme-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}
.theme-button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.desktop-theme {
  width: 100%;
  min-height: 30px;
  font-size: 10.5px;
}
.mobile-theme {
  display: none;
  width: 34px;
  height: 34px;
  margin-left: auto;
}

@media (max-width: 899px) {
  .sidebar {
    position: sticky;
    top: 0;
    width: 100%;
    height: 58px;
    overflow: visible;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    box-shadow: var(--shadow-header);
  }
  .brand-row {
    width: 100%;
    min-height: 57px;
    padding: 8px 12px;
    border-bottom: 0;
  }
  .brand-mark,
  .brand-mark svg {
    width: 32px;
    height: 32px;
  }
  .brand-name {
    font-size: 14px;
  }
  .brand-sub {
    max-width: 116px;
    font-size: 9px;
  }
  .traffic-panel {
    position: absolute;
    top: 9px;
    right: 54px;
    display: flex;
    min-width: 0;
    min-height: 0;
    align-items: flex-end;
    flex-direction: column;
    gap: 0;
    padding: 0 4px;
    border-bottom: 0;
  }
  .traffic-row {
    display: flex;
    max-width: 108px;
    gap: 4px;
    font-size: 9px;
  }
  .traffic-arrow {
    font-size: 10px;
  }
  .traffic-value {
    font-size: 9px;
  }
  .mobile-theme {
    display: inline-flex;
    margin-left: 4px;
  }
  .side-nav {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 40;
    display: grid;
    height: calc(62px + env(safe-area-inset-bottom));
    min-height: 0;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 1px;
    padding: 5px 4px calc(5px + env(safe-area-inset-bottom));
    overflow: visible;
    background: var(--bg-sidebar);
    border-top: 1px solid var(--border);
    box-shadow: var(--shadow-nav);
  }
  .side-nav-item {
    width: 100%;
    min-height: 50px;
    justify-content: center;
    flex-direction: column;
    gap: 2px;
    padding: 4px 1px;
    border-radius: var(--radius-sm);
    font-size: 9px;
    text-align: center;
  }
  .side-nav-item::before {
    top: auto;
    right: 28%;
    bottom: -6px;
    left: 28%;
    width: auto;
    height: 3px;
    border-radius: var(--radius-full) var(--radius-full) 0 0;
  }
  .side-nav-item.active {
    background: var(--bg-active);
    color: var(--text-primary);
  }
  .nav-icon {
    display: flex;
  }
  .nav-label {
    width: 100%;
    font-size: 9px;
    text-align: center;
  }
  .side-foot {
    display: none;
  }
}

@media (max-width: 420px) {
  .brand-sub {
    display: none;
  }
  .traffic-row {
    max-width: 92px;
  }
}
</style>
