<template>
  <div>
    <PageHeader :title="t('page.rules.title')" :desc="t('page.rules.desc')">
      <div class="search-box" style="width: 260px">
        <Icon name="search" :size="13" />
        <input v-model="searchQuery" type="text" :placeholder="t('rules.searchPlaceholder')" />
      </div>
      <span class="badge badge-neutral">{{ t('common.rulesCount', { n: filteredRules.length }) }}</span>
    </PageHeader>

    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th class="idx">{{ t('rules.colIndex') }}</th>
            <th>{{ t('rules.colType') }}</th>
            <th>{{ t('rules.colPayload') }}</th>
            <th>{{ t('rules.colTarget') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(rule, idx) in filteredRules" :key="idx">
            <td class="cell-mono text-muted idx">{{ idx + 1 }}</td>
            <td>
              <span class="badge badge-neutral">{{ rule.type }}</span>
            </td>
            <td class="cell-mono cell-truncate" :title="rule.payload || '-'">
              {{ rule.payload || '-' }}
            </td>
            <td>
              <span class="badge badge-accent">{{ rule.proxy }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="filteredRules.length === 0" icon="list-filter" :title="t('rules.empty')" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import { t } from "../i18n/index.js";
import { store } from "../stores/index.js";

const searchQuery = ref("");

const filteredRules = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return store.rules;
  return store.rules.filter((r) =>
    `${r.type} ${r.payload} ${r.proxy}`.toLowerCase().includes(q),
  );
});
</script>

<style scoped>
.idx {
  width: 56px;
}
</style>
