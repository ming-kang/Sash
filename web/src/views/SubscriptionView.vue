<template>
  <div>
    <PageHeader :title="t('page.subscription.title')" :desc="t('page.subscription.desc')" />

    <UiCard :title="t('subscription.cardTitle')">
      <template #actions>
        <span class="badge" :class="hasSubscription ? 'badge-success' : 'badge-neutral'">
          {{ hasSubscription ? t('subscription.configured') : t('subscription.empty') }}
        </span>
      </template>

      <p class="sub-desc">{{ t('subscription.desc') }}</p>

      <div v-if="hasSubscription" class="current-url">
        <span class="current-label">{{ t('subscription.currentUrl') }}</span>
        <span class="mono current-value" :title="store.status?.settings.subscriptionUrl">
          {{ store.status?.settings.subscriptionUrl }}
        </span>
      </div>

      <form class="sub-form" @submit.prevent="saveSubscription">
        <input
          v-model="subUrl"
          type="url"
          class="input"
          :placeholder="t('subscription.placeholder')"
          :disabled="updating"
          spellcheck="false"
        />
        <button type="submit" class="btn btn-primary" :disabled="updating || !subUrl.trim()">
          <Icon name="refresh" :size="13" :class="{ spin: updating }" />
          <span>{{ updating ? t('subscription.updating') : t('subscription.save') }}</span>
        </button>
      </form>

      <div v-if="hasSubscription" class="sub-actions">
        <button class="btn btn-secondary btn-sm" :disabled="updating" @click="refreshSubscription">
          <Icon name="refresh" :size="12" />
          <span>{{ t('subscription.refreshNow') }}</span>
        </button>
        <button class="btn btn-danger-outline btn-sm" :disabled="updating" @click="removeSubscription">
          <Icon name="trash" :size="12" />
          <span>{{ t('subscription.remove') }}</span>
        </button>
      </div>
    </UiCard>

    <UiCard :title="t('subscription.statsTitle')" class="mt-4">
      <div class="stat-grid">
        <div class="stat-box">
          <span class="stat-num">{{ totalNodes }}</span>
          <span class="stat-label">{{ t('subscription.statNodes') }}</span>
        </div>
        <div class="stat-box">
          <span class="stat-num">{{ store.proxyGroups.length }}</span>
          <span class="stat-label">{{ t('subscription.statGroups') }}</span>
        </div>
        <div class="stat-box">
          <span class="stat-num">{{ store.rules.length }}</span>
          <span class="stat-label">{{ t('subscription.statRules') }}</span>
        </div>
      </div>
    </UiCard>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api/index.js";
import { confirmDialog } from "../components/confirm.js";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import UiCard from "../components/UiCard.vue";
import { t } from "../i18n/index.js";
import { errorText, setProxies, store, toast } from "../stores/index.js";

const subUrl = ref(store.status?.settings.subscriptionUrl ?? "");
const updating = ref(false);

watch(
  () => store.status?.settings.subscriptionUrl,
  (val) => {
    if (val !== undefined) subUrl.value = val;
  },
);

const hasSubscription = computed(() => Boolean(store.status?.settings.subscriptionUrl));
const totalNodes = computed(() => Object.keys(store.proxies).length);

async function reloadAll(): Promise<void> {
  const [status, proxies, rules] = await Promise.all([
    api.getStatus(),
    api.getProxies(),
    api.getRules(),
  ]);
  store.status = status;
  setProxies(proxies.proxies);
  store.rules = rules.rules;
}

async function saveSubscription(): Promise<void> {
  const url = subUrl.value.trim();
  if (!url || updating.value) return;
  updating.value = true;
  try {
    const res = await api.setSubscription(url);
    await reloadAll();
    toast.success(t("toast.subSaved", { n: res.proxyCount }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    updating.value = false;
  }
}

async function refreshSubscription(): Promise<void> {
  if (updating.value) return;
  updating.value = true;
  try {
    const res = await api.refreshSubscription();
    await reloadAll();
    toast.success(t("toast.subRefreshed", { n: res.proxyCount }));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    updating.value = false;
  }
}

async function removeSubscription(): Promise<void> {
  const ok = await confirmDialog({
    title: t("subscription.removeConfirmTitle"),
    message: t("subscription.removeConfirmMsg"),
    confirmText: t("common.confirm"),
    cancelText: t("common.cancel"),
    danger: true,
  });
  if (!ok) return;
  updating.value = true;
  try {
    await api.unsetSubscription();
    await reloadAll();
    subUrl.value = "";
    toast.success(t("toast.subRemoved"));
  } catch (err) {
    toast.error(t("toast.failed", { msg: errorText(err) }));
  } finally {
    updating.value = false;
  }
}
</script>

<style scoped>
.sub-desc {
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: 14px;
}
.current-url {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  margin-bottom: 14px;
  min-width: 0;
}
.current-label {
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.current-value {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub-form {
  display: flex;
  gap: 8px;
}
.sub-form .input {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 12.5px;
}
.sub-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.stat-box {
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stat-num {
  font-size: 22px;
  font-weight: 700;
  font-family: var(--font-mono);
}
.stat-label {
  font-size: 12px;
  color: var(--text-muted);
}

@media (max-width: 640px) {
  .sub-form {
    flex-direction: column;
  }
  .stat-grid {
    grid-template-columns: 1fr;
  }
}
</style>
