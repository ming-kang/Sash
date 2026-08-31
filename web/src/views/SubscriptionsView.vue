<template>
  <div class="sub-view">
    <div class="glass-card sub-card">
      <div class="card-header">
        <div class="header-title">
          <Icon name="link" size="16" />
          <span>Remote Subscription</span>
        </div>
        <span class="badge" :class="hasSubscription ? 'badge-success' : 'badge-neutral'">
          {{ hasSubscription ? 'Configured' : 'Empty' }}
        </span>
      </div>

      <p class="desc-text">
        Import a Clash / Mihomo formatted subscription URL. Sash will fetch and validate nodes, compile routing rules, and hot-reload the running core.
      </p>

      <form class="sub-form" @submit.prevent="saveSubscription">
        <div class="input-group">
          <input
            v-model="subUrl"
            type="url"
            class="input"
            placeholder="https://example.com/api/v1/client/subscribe?token=..."
            required
            :disabled="updating"
          />
          <button type="submit" class="btn btn-primary" :disabled="updating || !subUrl.trim()">
            <Icon name="refresh" size="13" />
            <span>{{ updating ? 'Updating...' : 'Save & Update' }}</span>
          </button>
        </div>
      </form>

      <div v-if="hasSubscription" class="actions-row">
        <button class="btn btn-secondary btn-sm" :disabled="updating" @click="refreshSubscription">
          <Icon name="refresh" size="13" />
          <span>Refresh Now</span>
        </button>
        <button class="btn btn-danger-outline btn-sm" :disabled="updating" @click="clearSubscription">
          <Icon name="trash" size="13" />
          <span>Remove Subscription</span>
        </button>
      </div>
    </div>

    <!-- Details Card -->
    <div class="glass-card details-card mt-4">
      <div class="card-header">
        <div class="header-title">
          <Icon name="layers" size="16" />
          <span>Subscription Metadata</span>
        </div>
      </div>
      <div class="meta-grid">
        <div class="meta-box">
          <span class="meta-num text-sky">{{ totalNodes }}</span>
          <span class="meta-lbl">Total Proxies</span>
        </div>
        <div class="meta-box">
          <span class="meta-num text-success">{{ store.proxyGroups.length }}</span>
          <span class="meta-lbl">Proxy Groups</span>
        </div>
        <div class="meta-box">
          <span class="meta-num text-warning">{{ store.rules.length }}</span>
          <span class="meta-lbl">Routing Rules</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api/index.js";
import Icon from "../components/Icon.vue";
import { setProxies, store } from "../stores/index.js";

const subUrl = ref(store.status?.settings.subscriptionUrl ?? "");
const updating = ref(false);

watch(
  () => store.status?.settings.subscriptionUrl,
  (val) => {
    if (val !== undefined) subUrl.value = val;
  },
);

const hasSubscription = computed(() => Boolean(store.status?.settings.subscriptionUrl));

const totalNodes = computed(() => {
  return Object.keys(store.proxies).length;
});

async function saveSubscription(): Promise<void> {
  const url = subUrl.value.trim();
  if (!url) return;
  updating.value = true;

  try {
    const res = await api.setSubscription(url);
    alert(`Subscription saved! Loaded ${res.proxyCount} proxies.`);
    const [newStatus, newProxies, newRules] = await Promise.all([
      api.getStatus(),
      api.getProxies(),
      api.getRules(),
    ]);
    store.status = newStatus;
    setProxies(newProxies.proxies);
    store.rules = newRules.rules;
  } catch (err) {
    alert(`Failed to save subscription: ${(err as Error).message}`);
  } finally {
    updating.value = false;
  }
}

async function refreshSubscription(): Promise<void> {
  updating.value = true;
  try {
    const res = await api.refreshSubscription();
    alert(`Subscription refreshed! Loaded ${res.proxyCount} proxies.`);
    const [newProxies, newRules] = await Promise.all([api.getProxies(), api.getRules()]);
    setProxies(newProxies.proxies);
    store.rules = newRules.rules;
  } catch (err) {
    alert(`Failed to refresh subscription: ${(err as Error).message}`);
  } finally {
    updating.value = false;
  }
}

async function clearSubscription(): Promise<void> {
  if (!confirm("Remove subscription and revert to default DIRECT config?")) return;
  updating.value = true;
  try {
    await api.unsetSubscription();
    const [newStatus, newProxies, newRules] = await Promise.all([
      api.getStatus(),
      api.getProxies(),
      api.getRules(),
    ]);
    store.status = newStatus;
    setProxies(newProxies.proxies);
    store.rules = newRules.rules;
    subUrl.value = "";
  } catch (err) {
    alert(`Failed to remove subscription: ${(err as Error).message}`);
  } finally {
    updating.value = false;
  }
}
</script>

<style scoped>
.sub-view {
  display: flex;
  flex-direction: column;
}
.mt-4 {
  margin-top: 16px;
}

.sub-card,
.details-card {
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
  font-size: 15px;
  font-weight: 600;
}

.desc-text {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.input-group {
  display: flex;
  gap: 8px;
}

.actions-row {
  display: flex;
  gap: 10px;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.meta-box {
  background: var(--bg-input);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-sm);
  padding: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.meta-num {
  font-size: 22px;
  font-weight: 700;
  font-family: var(--font-mono);
}

.meta-lbl {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  font-weight: 600;
}

.text-sky {
  color: #38bdf8;
}
.text-success {
  color: var(--color-success);
}
.text-warning {
  color: var(--color-warning);
}
</style>
