<template>
  <div class="settings-view">
    <!-- Inbound & Network -->
    <div class="glass-card setting-section">
      <div class="section-header">
        <Icon name="globe" size="16" />
        <span class="section-title">Network & Inbound Listeners</span>
      </div>

      <div class="settings-list">
        <!-- Mixed Port -->
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-name">Mixed Proxy Port</span>
            <span class="setting-desc">Local port for HTTP & SOCKS5 mixed inbound (default: 17890)</span>
          </div>
          <div class="setting-action">
            <input
              v-model.number="mixedPort"
              type="number"
              min="1"
              max="65535"
              class="input input-sm port-input"
            />
            <button class="btn btn-secondary btn-sm" @click="saveMixedPort">Save</button>
          </div>
        </div>

        <!-- Allow LAN -->
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-name">Allow LAN Connections</span>
            <span class="setting-desc">Accept proxy traffic from other devices on your local area network</span>
          </div>
          <div class="setting-action">
            <button
              class="btn btn-sm"
              :class="allowLan ? 'btn-primary' : 'btn-secondary'"
              @click="toggleAllowLan"
            >
              {{ allowLan ? 'Enabled' : 'Disabled' }}
            </button>
          </div>
        </div>

        <!-- TUN Mode -->
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-name">TUN Mode (Virtual Network Interface)</span>
            <span class="setting-desc">Transparently route all system network traffic (requires Administrator/root)</span>
          </div>
          <div class="setting-action">
            <button
              class="btn btn-sm"
              :class="tunMode ? 'btn-primary' : 'btn-secondary'"
              @click="toggleTun"
            >
              {{ tunMode ? 'Enabled' : 'Disabled' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Core Management -->
    <div class="glass-card setting-section mt-4">
      <div class="section-header">
        <Icon name="activity" size="16" />
        <span class="section-title">Core Process Control</span>
      </div>

      <div class="settings-list">
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-name">Restart Core Process</span>
            <span class="setting-desc">Reboots the child core process and re-applies configuration</span>
          </div>
          <div class="setting-action">
            <button class="btn btn-secondary btn-sm" @click="restartCore">
              <Icon name="refresh" size="13" />
              <span>Restart Core</span>
            </button>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-name">Hot-Reload Configuration</span>
            <span class="setting-desc">Recompiles config.yaml and signals core without restart</span>
          </div>
          <div class="setting-action">
            <button class="btn btn-secondary btn-sm" @click="reloadConfig">
              <Icon name="refresh" size="13" />
              <span>Reload Config</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Supervisor Ports -->
    <div class="glass-card setting-section mt-4">
      <div class="section-header">
        <Icon name="settings" size="16" />
        <span class="section-title">Supervisor Ports</span>
      </div>

      <div class="settings-list">
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-name">Sash Unified Control Port</span>
            <span class="setting-desc">Supervisor loopback API & WebUI dashboard address</span>
          </div>
          <div class="setting-action">
            <span class="badge badge-neutral">127.0.0.1:{{ store.status?.settings.daemonPort ?? 19090 }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { api } from "../api/index.js";
import Icon from "../components/Icon.vue";
import { store } from "../stores/index.js";

const mixedPort = ref(store.status?.settings.mixedPort ?? 17890);
const allowLan = ref(store.status?.settings.allowLan ?? false);
const tunMode = ref(store.status?.settings.tun ?? false);

watch(
  () => store.status?.settings,
  (s) => {
    if (!s) return;
    mixedPort.value = s.mixedPort;
    allowLan.value = s.allowLan;
    tunMode.value = s.tun;
  },
);

async function saveMixedPort(): Promise<void> {
  try {
    await api.patchSetting("mixed-port", String(mixedPort.value));
    alert("Mixed port updated! Core restarted.");
    const s = await api.getStatus();
    store.status = s;
  } catch (err) {
    alert(`Failed to update port: ${(err as Error).message}`);
  }
}

async function toggleAllowLan(): Promise<void> {
  const next = !allowLan.value;
  try {
    await api.patchSetting("allow-lan", next ? "on" : "off");
    const s = await api.getStatus();
    store.status = s;
  } catch (err) {
    alert(`Failed to toggle allow-lan: ${(err as Error).message}`);
  }
}

async function toggleTun(): Promise<void> {
  const next = !tunMode.value;
  try {
    await api.patchSetting("tun", next ? "on" : "off");
    const s = await api.getStatus();
    store.status = s;
  } catch (err) {
    alert(`Failed to toggle TUN: ${(err as Error).message}`);
  }
}

async function restartCore(): Promise<void> {
  try {
    await api.restartCore();
    alert("Core restarted successfully.");
    const s = await api.getStatus();
    store.status = s;
  } catch (err) {
    alert(`Failed to restart core: ${(err as Error).message}`);
  }
}

async function reloadConfig(): Promise<void> {
  try {
    const res = await api.reloadCoreConfig();
    alert(`Config reloaded with ${res.proxyCount} proxies.`);
  } catch (err) {
    alert(`Failed to reload config: ${(err as Error).message}`);
  }
}
</script>

<style scoped>
.settings-view {
  display: flex;
  flex-direction: column;
}
.mt-4 {
  margin-top: 16px;
}

.setting-section {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
}

.settings-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.setting-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.setting-name {
  font-size: 13.5px;
  font-weight: 600;
  display: block;
}

.setting-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}

.setting-action {
  display: flex;
  align-items: center;
  gap: 8px;
}

.port-input {
  width: 90px;
}
</style>
