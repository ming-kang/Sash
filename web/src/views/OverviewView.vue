<template>
  <div class="overview-view">
    <!-- Top Speed Meters -->
    <div class="grid grid-cols-2 gap-4">
      <!-- Download Card -->
      <div class="glass-card stat-card">
        <div class="card-top">
          <div class="stat-meta">
            <span class="stat-label">Download Speed</span>
            <div class="stat-speed text-success">
              <Icon name="download" size="18" />
              <span>{{ formatSpeed(store.traffic.down) }}</span>
            </div>
          </div>
          <span class="badge badge-success">LIVE</span>
        </div>
        <div class="chart-box">
          <svg viewBox="0 0 320 48" class="sparkline">
            <polyline
              fill="none"
              stroke="#10b981"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              :points="renderSparkline(store.traffic.historyDown)"
            />
          </svg>
        </div>
      </div>

      <!-- Upload Card -->
      <div class="glass-card stat-card">
        <div class="card-top">
          <div class="stat-meta">
            <span class="stat-label">Upload Speed</span>
            <div class="stat-speed text-sky">
              <Icon name="upload" size="18" />
              <span>{{ formatSpeed(store.traffic.up) }}</span>
            </div>
          </div>
          <span class="badge badge-primary">LIVE</span>
        </div>
        <div class="chart-box">
          <svg viewBox="0 0 320 48" class="sparkline">
            <polyline
              fill="none"
              stroke="#0ea5e9"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              :points="renderSparkline(store.traffic.historyUp)"
            />
          </svg>
        </div>
      </div>
    </div>

    <!-- Main Controls Row -->
    <div class="grid grid-cols-2 gap-4 mt-4">
      <!-- Outbound Mode Switcher -->
      <div class="glass-card action-card">
        <div class="card-header">
          <div class="header-title">
            <Icon name="globe" size="16" />
            <span>Outbound Mode</span>
          </div>
          <span class="badge badge-neutral">{{ store.mode.toUpperCase() }}</span>
        </div>
        <div class="mode-grid">
          <button
            v-for="m in modes"
            :key="m.id"
            class="mode-btn"
            :class="{ active: store.mode === m.id }"
            @click="switchMode(m.id)"
          >
            <span class="mode-title">{{ m.name }}</span>
            <span class="mode-desc">{{ m.desc }}</span>
          </button>
        </div>
      </div>

      <!-- OS System Proxy Toggle -->
      <div class="glass-card action-card">
        <div class="card-header">
          <div class="header-title">
            <Icon name="shield" size="16" />
            <span>OS System Proxy</span>
          </div>
          <span class="badge" :class="isSysProxyOn ? 'badge-success' : 'badge-neutral'">
            {{ isSysProxyOn ? 'Active' : 'Disabled' }}
          </span>
        </div>
        <div class="sysproxy-body">
          <p class="desc-text">
            {{
              isSysProxyOn
                ? `System network traffic routes through 127.0.0.1:${store.status?.settings.mixedPort ?? 17890}`
                : 'Direct connection: OS network settings are not currently pointing at local proxy.'
            }}
          </p>
          <button
            class="btn"
            :class="isSysProxyOn ? 'btn-danger-outline' : 'btn-primary'"
            :disabled="!isCoreRunning || togglingProxy"
            @click="toggleSystemProxy"
          >
            <Icon name="power" size="14" />
            <span>{{ isSysProxyOn ? 'Disable System Proxy' : 'Enable System Proxy' }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Bottom Metadata Row -->
    <div class="grid grid-cols-2 gap-4 mt-4">
      <!-- Primary Group & Node -->
      <div class="glass-card info-card">
        <div class="card-header">
          <div class="header-title">
            <Icon name="zap" size="16" />
            <span>Primary Outbound</span>
          </div>
          <button class="link-btn" @click="store.currentTab = 'proxies'">All Proxies →</button>
        </div>
        <div class="active-node-box">
          <div class="group-tag">{{ primaryGroup }}</div>
          <div class="node-display">
            <div class="node-main">
              <span class="node-dot"></span>
              <span class="node-name">{{ activeNodeName }}</span>
            </div>
            <span
              v-if="activeNodeDelay !== undefined"
              class="badge"
              :class="delayBadgeClass(activeNodeDelay)"
            >
              {{ activeNodeDelay > 0 ? `${activeNodeDelay} ms` : 'Timeout' }}
            </span>
          </div>
        </div>
      </div>

      <!-- Core Runtime Details -->
      <div class="glass-card info-card">
        <div class="card-header">
          <div class="header-title">
            <Icon name="activity" size="16" />
            <span>Core & Endpoints</span>
          </div>
          <span class="badge" :class="isCoreRunning ? 'badge-success' : 'badge-danger'">
            {{ isCoreRunning ? 'Running' : 'Stopped' }}
          </span>
        </div>
        <div class="meta-list">
          <div class="meta-item">
            <span class="meta-key">Core Version</span>
            <span class="meta-value">{{ store.status?.core.version || store.status?.settings.coreVersion || 'Installed' }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-key">Mixed Proxy Port</span>
            <span class="meta-value">127.0.0.1:{{ store.status?.settings.mixedPort ?? 17890 }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-key">Sash API Endpoint</span>
            <span class="meta-value">127.0.0.1:{{ store.status?.settings.daemonPort ?? 19090 }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { api } from "../api/index.js";
import Icon from "../components/Icon.vue";
import { isCoreRunning, isSysProxyOn, store } from "../stores/index.js";
import type { OutboundMode } from "../types/index.js";

const togglingProxy = ref(false);

const modes = [
  { id: "rule" as OutboundMode, name: "Rule", desc: "Split-routing via rules" },
  { id: "global" as OutboundMode, name: "Global", desc: "Route everything via proxy" },
  { id: "direct" as OutboundMode, name: "Direct", desc: "Bypass all proxies" },
];

const primaryGroup = computed(() => {
  return (
    store.proxyGroups.find((g) => g.toUpperCase() === "PROXY" || g.toUpperCase() === "GLOBAL") ??
    store.proxyGroups[0] ??
    "PROXY"
  );
});

const activeNodeName = computed(() => {
  const g = store.proxies[primaryGroup.value];
  return g?.now ?? "DIRECT";
});

const activeNodeDelay = computed(() => {
  const item = store.proxies[activeNodeName.value];
  return item?.history?.slice(-1)[0]?.delay;
});

function formatSpeed(bytes: number): string {
  if (bytes === 0) return "0 B/s";
  const k = 1024;
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

function renderSparkline(data: number[]): string {
  const max = Math.max(...data, 1024);
  const width = 320;
  const height = 48;
  const step = width / (data.length - 1);
  return data
    .map((val, idx) => {
      const x = idx * step;
      const y = height - (val / max) * (height - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function delayBadgeClass(delay: number): string {
  if (delay === 0) return "badge-danger";
  if (delay < 300) return "badge-success";
  if (delay < 600) return "badge-warning";
  return "badge-danger";
}

async function switchMode(mode: OutboundMode): Promise<void> {
  try {
    await api.setMode(mode);
    store.mode = mode;
  } catch (err) {
    alert(`Failed to set mode: ${(err as Error).message}`);
  }
}

async function toggleSystemProxy(): Promise<void> {
  togglingProxy.value = true;
  try {
    if (isSysProxyOn.value) {
      await api.disableSystemProxy();
    } else {
      await api.enableSystemProxy();
    }
    const newStatus = await api.getStatus();
    store.status = newStatus;
  } catch (err) {
    alert(`Failed to toggle system proxy: ${(err as Error).message}`);
  } finally {
    togglingProxy.value = false;
  }
}
</script>

<style scoped>
.overview-view {
  display: flex;
  flex-direction: column;
}

.grid {
  display: grid;
}
.grid-cols-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.gap-4 {
  gap: 16px;
}
.mt-4 {
  margin-top: 16px;
}

.stat-card {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.stat-label {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.stat-speed {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 20px;
  font-weight: 700;
  font-family: var(--font-mono);
  margin-top: 4px;
}

.text-success {
  color: var(--color-success);
}
.text-sky {
  color: #38bdf8;
}

.chart-box {
  height: 48px;
  margin-top: 10px;
}

.sparkline {
  width: 100%;
  height: 100%;
}

.action-card,
.info-card {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.mode-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.mode-btn {
  background: var(--bg-input);
  border: 1px solid #1f2937;
  border-radius: var(--radius-sm);
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
  transition: all 0.15s ease;
  color: var(--text-secondary);
}

.mode-btn:hover {
  background: #1f2937;
  border-color: #374151;
  color: var(--text-primary);
}

.mode-btn.active {
  background: rgba(2, 132, 199, 0.15);
  border-color: #0284c7;
  color: #38bdf8;
}

.mode-title {
  font-weight: 600;
  font-size: 13px;
}

.mode-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}

.sysproxy-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.desc-text {
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.link-btn {
  background: none;
  border: none;
  color: #38bdf8;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.link-btn:hover {
  text-decoration: underline;
}

.active-node-box {
  background: var(--bg-input);
  border: 1px solid #1f2937;
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.group-tag {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text-muted);
  letter-spacing: 0.05em;
}

.node-display {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.node-main {
  display: flex;
  align-items: center;
  gap: 8px;
}

.node-dot {
  width: 7px;
  height: 7px;
  background: var(--color-success);
  border-radius: 9999px;
}

.node-name {
  font-size: 14px;
  font-weight: 600;
}

.meta-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12.5px;
}

.meta-key {
  color: var(--text-muted);
}
.meta-value {
  font-family: var(--font-mono);
  font-weight: 500;
}

@media (max-width: 768px) {
  .grid-cols-2 {
    grid-template-columns: 1fr;
  }
}
</style>
