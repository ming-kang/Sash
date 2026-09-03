<template>
  <div>
    <PageHeader :title="t('page.rules.title')" :desc="t('page.rules.desc')">
      <div class="search-box rule-search">
        <Icon name="search" :size="13" />
        <input
          v-model="searchQuery"
          type="search"
          :aria-label="t('rules.searchPlaceholder')"
          :placeholder="t('rules.searchPlaceholder')"
        />
      </div>
      <span class="badge badge-neutral">{{ t('common.rulesCount', { n: filteredRules.length }) }}</span>
    </PageHeader>

    <div class="table-wrap rule-list">
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
          <tr v-for="entry in filteredRules" :key="entry.key">
            <td class="cell-mono text-muted idx" :data-label="t('rules.colIndex')">
              {{ entry.originalIndex + 1 }}
            </td>
            <td :data-label="t('rules.colType')">
              <span class="badge badge-neutral">{{ entry.rule.type }}</span>
            </td>
            <td
              class="cell-mono cell-truncate"
              :data-label="t('rules.colPayload')"
              :title="entry.rule.payload || '-'"
            >
              {{ entry.rule.payload || '-' }}
            </td>
            <td :data-label="t('rules.colTarget')">
              <span class="badge badge-accent">{{ entry.rule.proxy }}</span>
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

const indexedRules = computed(() =>
  store.rules.map((rule, originalIndex) => ({
    rule,
    originalIndex,
    key: `${rule.type}\u0000${rule.payload}\u0000${rule.proxy}\u0000${originalIndex}`,
    searchKey: `${rule.type ?? ""}\u0000${rule.payload ?? ""}\u0000${rule.proxy ?? ""}`.toLowerCase(),
  })),
);
const filteredRules = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return indexedRules.value;
  return indexedRules.value.filter(({ searchKey }) => searchKey.includes(query));
});
</script>

<style scoped>
.rule-search {
  width: 260px;
}
.rule-list {
  border-right: 0;
  border-left: 0;
  border-radius: 0;
}
.data-table th,
.data-table td {
  padding-top: 7px;
  padding-bottom: 7px;
  text-align: center;
}
.data-table th:not(:last-child),
.data-table td:not(:last-child) {
  border-right: 1px solid var(--border);
}
.data-table .cell-truncate {
  text-align: center;
}
.idx {
  width: 56px;
}

@media (max-width: 760px) {
  :deep(.page-head-actions) {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .rule-search {
    width: min(260px, 100%);
  }
  .rule-list {
    overflow: visible;
    border: 0;
    background: transparent;
    box-shadow: none;
  }
  .data-table,
  .data-table tbody,
  .data-table tr,
  .data-table td {
    display: block;
    width: 100%;
  }
  .data-table thead {
    display: none;
  }
  .data-table tbody {
    display: grid;
    gap: 10px;
  }
  .data-table tbody tr {
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    box-shadow: none;
  }
  .data-table td {
    display: grid;
    grid-template-columns: minmax(70px, 0.3fr) minmax(0, 1fr);
    align-items: baseline;
    gap: 10px;
    max-width: none;
    padding: 4px 0;
    border: 0;
    text-align: left;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .data-table td::before {
    content: attr(data-label);
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .data-table .idx {
    width: 100%;
  }
}

@media (max-width: 480px) {
  :deep(.page-head) {
    flex-direction: column;
  }
  :deep(.page-head-actions) {
    width: 100%;
    justify-content: flex-start;
  }
  .rule-search {
    width: 100%;
    flex-basis: 100%;
  }
}
</style>
