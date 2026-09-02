<template>
  <aside class="sidebar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 36 36">
          <rect width="36" height="36" rx="11" fill="var(--accent)" />
          <path
            d="M23 12.6c-.8-2.1-2.9-3.3-5.5-3.3-3.2 0-5.6 1.9-5.6 4.5 0 5.9 11.7 3.2 11.7 8.8 0 2.8-2.6 4.6-6 4.6-3 0-5.5-1.5-6.2-3.8"
            fill="none"
            stroke="var(--accent-contrast)"
            stroke-width="2.8"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <div class="brand-text">
        <span class="brand-name">Sash</span>
        <span class="brand-sub">{{ t('app.subtitle') }}</span>
      </div>

      <div class="mobile-tools">
        <div class="mobile-speeds" aria-live="off">
          <span class="speed-item down" :title="t('overview.download')">
            <Icon name="arrow-down" :size="11" :stroke-width="2.5" />
            <span class="mono">{{ formatSpeed(store.traffic.down) }}</span>
          </span>
          <span class="speed-item up" :title="t('overview.upload')">
            <Icon name="arrow-up" :size="11" :stroke-width="2.5" />
            <span class="mono">{{ formatSpeed(store.traffic.up) }}</span>
          </span>
        </div>
        <button
          type="button"
          class="theme-button"
          :aria-label="themeButtonLabel"
          :title="themeTitle"
          @click="cycleTheme"
        >
          <Icon :name="themeIcon" :size="17" />
        </button>
      </div>
    </div>

    <nav class="side-nav" :aria-label="t('app.navigation')">
      <button
        v-for="item in navItems"
        :key="item.route"
        type="button"
        class="side-nav-item"
        :class="{ active: currentRoute === item.route }"
        :aria-label="t(`nav.${item.route}`)"
        :title="t(`nav.${item.route}`)"
        :aria-current="currentRoute === item.route ? 'page' : undefined"
        @click="navigate(item.route)"
      >
        <span class="nav-icon"><Icon :name="item.icon" :size="20" /></span>
        <span class="nav-label">{{ t(`nav.${item.route}`) }}</span>
      </button>
    </nav>

    <div class="side-foot">
      <div class="speed-stack" aria-live="off">
        <span class="speed-item down" :title="t('overview.download')">
          <Icon name="arrow-down" :size="12" :stroke-width="2.5" />
          <span class="mono">{{ formatSpeed(store.traffic.down) }}</span>
        </span>
        <span class="speed-item up" :title="t('overview.upload')">
          <Icon name="arrow-up" :size="12" :stroke-width="2.5" />
          <span class="mono">{{ formatSpeed(store.traffic.up) }}</span>
        </span>
      </div>
      <div class="core-row" :title="coreTooltip">
        <span class="dot" :class="isCoreRunning ? 'dot-success' : 'dot-muted'" />
        <span class="core-label">
          {{ isCoreRunning ? t('common.running') : t('common.stopped') }}
        </span>
        <span v-if="coreVersion" class="core-ver mono">{{ coreVersion }}</span>
      </div>
      <button
        type="button"
        class="theme-button desktop-theme"
        :aria-label="themeButtonLabel"
        :title="themeTitle"
        @click="cycleTheme"
      >
        <Icon :name="themeIcon" :size="17" />
        <span>{{ themeName }}</span>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import { t } from "../i18n/index.js";
import { currentRoute, navigate, type Route } from "../router.js";
import { isCoreRunning, store } from "../stores/index.js";
import { cycleTheme, theme } from "../theme.js";
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
  const version = store.status?.core.version;
  return version ? (version.startsWith("v") ? version : `v${version}`) : "";
});

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
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  width: var(--sidebar-w);
  height: 100dvh;
  flex-shrink: 0;
  flex-direction: column;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
}

.brand {
  display: flex;
  min-height: 76px;
  align-items: center;
  justify-content: center;
  padding: 16px 12px 10px;
}
.brand-mark {
  display: flex;
}
.brand-mark svg {
  display: block;
  width: 38px;
  height: 38px;
  filter: drop-shadow(0 4px 8px var(--accent-shadow));
}
.brand-text,
.mobile-tools {
  display: none;
}

.side-nav {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  padding: 6px 7px;
  overflow-y: auto;
}
.side-nav-item {
  position: relative;
  display: flex;
  width: 100%;
  min-height: 58px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 4px;
  padding: 7px 3px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    color var(--motion-fast) var(--ease-standard),
    background var(--motion-fast) var(--ease-standard),
    transform var(--motion-fast) var(--ease-standard);
}
.side-nav-item::before {
  position: absolute;
  top: 14px;
  bottom: 14px;
  left: -8px;
  width: 3px;
  border-radius: 0 999px 999px 0;
  background: var(--accent);
  content: "";
  opacity: 0;
  transform: scaleY(0.45);
  transition:
    opacity var(--motion-fast) var(--ease-standard),
    transform var(--motion-fast) var(--ease-spring);
}
.side-nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.side-nav-item:active {
  transform: scale(0.97);
}
.side-nav-item.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.side-nav-item.active::before {
  opacity: 1;
  transform: scaleY(1);
}
.nav-icon {
  display: flex;
}
.nav-label {
  width: 100%;
  overflow: hidden;
  font-size: 10px;
  font-weight: 650;
  line-height: 1.15;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side-foot {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px 8px max(14px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--border);
}
.speed-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.speed-item {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  font-size: 9.5px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.speed-item.down {
  color: var(--chart-down);
}
.speed-item.up {
  color: var(--chart-up);
}
.speed-item .mono {
  overflow: hidden;
  text-overflow: ellipsis;
}
.core-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  color: var(--text-secondary);
  font-size: 9.5px;
}
.core-label,
.core-ver {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.core-ver {
  color: var(--text-muted);
  font-size: 9px;
}
.theme-button {
  display: inline-flex;
  min-width: 36px;
  min-height: 36px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    color var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard),
    background var(--motion-fast) var(--ease-standard);
}
.theme-button:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
  color: var(--accent);
}
.desktop-theme {
  width: 100%;
  min-height: 32px;
  font-size: 9.5px;
  font-weight: 600;
}

@media (max-width: 899px) {
  .sidebar {
    width: 100%;
    height: 60px;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    box-shadow: var(--shadow-header);
  }
  .brand {
    width: 100%;
    min-height: 59px;
    justify-content: flex-start;
    gap: 9px;
    padding: 9px 12px;
  }
  .brand-mark svg {
    width: 32px;
    height: 32px;
  }
  .brand-text {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }
  .brand-name {
    font-size: 14px;
    font-weight: 750;
    line-height: 1.15;
  }
  .brand-sub {
    overflow: hidden;
    max-width: 116px;
    color: var(--text-muted);
    font-size: 9px;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mobile-tools {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }
  .mobile-speeds {
    display: flex;
    min-width: 0;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
  }
  .mobile-speeds .speed-item {
    max-width: 104px;
    font-size: 9px;
  }
  .mobile-speeds .speed-item .mono {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .theme-button {
    min-width: 36px;
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
    min-height: 50px;
    gap: 3px;
    padding: 4px 1px;
    border-radius: var(--radius-sm);
  }
  .side-nav-item::before {
    top: auto;
    right: 28%;
    bottom: -6px;
    left: 28%;
    width: auto;
    height: 3px;
    border-radius: 999px 999px 0 0;
    transform: scaleX(0.4);
  }
  .side-nav-item.active::before {
    transform: scaleX(1);
  }
  .nav-label {
    font-size: 9px;
  }
  .side-foot {
    display: none;
  }
}

@media (max-width: 420px) {
  .brand-sub {
    display: none;
  }
  .mobile-tools {
    gap: 5px;
  }
  .mobile-speeds .speed-item {
    max-width: 88px;
  }
}
</style>
