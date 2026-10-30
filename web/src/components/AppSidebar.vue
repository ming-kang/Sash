<template>
  <aside class="sidebar">
    <div class="brand">
      <img class="brand-mark" :src="'./assets/branding/sash-cat.png'" alt="" />
      <span class="brand-name">Sash</span>
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
      <Transition name="dock">
        <div v-if="applyPending" class="pending-config" role="status">
          <span class="pending-config-copy">
            <Icon name="warning" :size="14" />
            {{ t('settings.pendingApply') }}
          </span>
          <CoreControls apply-only />
        </div>
      </Transition>
      <div class="core-row" :title="coreTooltip">
        <span class="dot" :class="isCoreRunning ? 'dot-success' : 'dot-muted'" />
        <span class="core-label">Core</span>
        <span class="core-state">
          {{ isCoreRunning ? t('common.running') : t('common.stopped') }}
        </span>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { applyPending } from "../composables/core-runtime.js";
import { t } from "../i18n/index.js";
import { currentRoute, navigate, type Route } from "../router.js";
import { isCoreRunning, store } from "../stores/index.js";
import CoreControls from "./CoreControls.vue";
import Icon from "./Icon.vue";

const navItems: Array<{ route: Route; icon: string }> = [
  { route: "overview", icon: "grid" },
  { route: "profiles", icon: "layers" },
  { route: "logs", icon: "terminal" },
  { route: "connections", icon: "swap" },
  { route: "rules", icon: "list-filter" },
  { route: "settings", icon: "settings" },
];

const coreTooltip = computed(() => {
  const status = isCoreRunning.value ? t("app.coreRunning") : t("app.coreStopped");
  return store.status?.core.pid ? `${status} · PID ${store.status.core.pid}` : status;
});
</script>

<style scoped>
.sidebar {
  position: relative;
  z-index: var(--z-sidebar);
  display: flex;
  width: var(--sidebar-w);
  height: 100%;
  flex-shrink: 0;
  flex-direction: column;
  padding: 0 12px 14px;
  overflow: hidden;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
}
.brand {
  display: flex;
  min-height: 82px;
  align-items: center;
  gap: 11px;
  padding: 0 9px;
}
.brand-mark {
  display: block;
  width: 39px;
  height: 39px;
  flex-shrink: 0;
  object-fit: contain;
}
.brand-name {
  color: var(--text-primary);
  font-family: var(--font-brand);
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.035em;
  line-height: 1.15;
}
.side-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 12px;
}
.side-nav-item {
  position: relative;
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 11px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--menu-text);
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  text-align: left;
  transition:
    background var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard),
    transform var(--motion-fast) var(--ease-standard);
}
.side-nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.side-nav-item:active {
  transform: scale(0.985);
}
.side-nav-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 650;
}
.nav-icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
}
.nav-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Saved changes wait beside the Core state instead of floating over the page. */
.side-foot {
  display: flex;
  margin-top: auto;
  flex-direction: column;
  gap: 8px;
  padding: 16px 2px 0;
}
.pending-config {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 11px;
  background: var(--warning-soft);
  border: 1px solid var(--warning-border);
  border-radius: var(--radius-md);
}
.pending-config-copy {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 550;
  line-height: 1.45;
}
.pending-config-copy > .sash-icon {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--warning);
}
.pending-config :deep(.btn) {
  flex: 1;
}
/* Fade in only: once applied, the prompt leaves at once instead of lingering. */
.dock-enter-active {
  transition: opacity var(--motion-normal) var(--ease-standard);
}
.dock-enter-from {
  opacity: 0;
}
.core-row {
  display: flex;
  min-height: 40px;
  align-items: center;
  gap: 8px;
  padding: 8px 11px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 12px;
}
.core-label {
  color: var(--text-primary);
  font-weight: 600;
}
.core-state {
  margin-left: auto;
  overflow: hidden;
  color: var(--text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 899px) {
  .sidebar {
    position: static;
    width: 100%;
    height: 0;
    padding: 0;
    overflow: visible;
    border: 0;
  }
  .brand,
  .core-row {
    display: none;
  }
  /* The dock rests on the bottom navigation; App reserves --dock-h so it never covers content. */
  .side-foot {
    position: fixed;
    right: 0;
    bottom: calc(66px + env(safe-area-inset-bottom));
    left: 0;
    z-index: 40;
    margin: 0;
    padding: 0;
  }
  .pending-config {
    min-height: var(--dock-h);
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 5px max(10px, env(safe-area-inset-right)) 5px max(16px, env(safe-area-inset-left));
    border-width: 1px 0 0;
    border-radius: 0;
  }
  .pending-config-copy {
    align-items: center;
    font-size: 13px;
  }
  .pending-config-copy > .sash-icon {
    margin-top: 0;
  }
  .pending-config :deep(.btn) {
    flex: none;
  }
  .side-nav {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 40;
    display: grid;
    height: calc(66px + env(safe-area-inset-bottom));
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 2px;
    padding: 5px 6px calc(5px + env(safe-area-inset-bottom));
    background: color-mix(in srgb, var(--bg-sidebar) 94%, transparent);
    border-top: 1px solid var(--border);
    box-shadow: var(--shadow-nav);
    backdrop-filter: blur(16px);
  }
  .side-nav-item,
  .side-nav-item.active {
    min-height: 50px;
    justify-content: center;
    flex-direction: column;
    gap: 3px;
    padding: 4px 1px;
    border-radius: var(--radius-md);
    font-size: 11px;
    text-align: center;
  }
  .side-nav-item.active {
    background: var(--accent-soft);
  }
  .side-nav-item:active {
    transform: none;
  }
  .nav-label {
    width: 100%;
    font-size: clamp(9px, 2.65vw, 11px);
    letter-spacing: -0.015em;
    line-height: 1.2;
  }
}
</style>
