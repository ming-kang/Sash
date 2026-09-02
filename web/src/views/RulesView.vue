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
          <tr v-for="entry in pagedRules" :key="entry.key">
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
      <footer v-else class="pagination-footer">
        <span class="pagination-summary">
          {{
            t('common.pageSummary', {
              page: currentPage,
              total: totalPages,
            })
          }}
        </span>
        <div class="pagination-actions">
          <button
            class="btn btn-secondary btn-sm"
            :aria-label="t('common.previous')"
            :disabled="currentPage === 1"
            @click="currentPage--"
          >
            {{ t('common.previous') }}
          </button>
          <button
            class="btn btn-secondary btn-sm"
            :aria-label="t('common.next')"
            :disabled="currentPage === totalPages"
            @click="currentPage++"
          >
            {{ t('common.next') }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import { t } from "../i18n/index.js";
import { store } from "../stores/index.js";

const PAGE_SIZE = 120;
const searchQuery = ref("");
const currentPage = ref(1);

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
const totalPages = computed(() => Math.max(1, Math.ceil(filteredRules.value.length / PAGE_SIZE)));
const pageStart = computed(() => (currentPage.value - 1) * PAGE_SIZE);
const pageEnd = computed(() => Math.min(pageStart.value + PAGE_SIZE, filteredRules.value.length));
const pagedRules = computed(() => filteredRules.value.slice(pageStart.value, pageEnd.value));

watch(searchQuery, () => {
  currentPage.value = 1;
});
watch(
  totalPages,
  (pages) => {
    currentPage.value = Math.min(currentPage.value, pages);
  },
  { immediate: true },
);
</script>

<style scoped>
.rule-search {
  width: 260px;
}
.idx {
  width: 56px;
}
.pagination-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}
.pagination-summary {
  color: var(--text-muted);
  font-size: 12px;
}
.pagination-actions {
  display: flex;
  gap: 8px;
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
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .data-table td::before {
    content: attr(data-label);
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .data-table .idx {
    width: 100%;
  }
  .pagination-footer {
    margin-top: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
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
  .pagination-footer {
    align-items: stretch;
    flex-direction: column;
  }
  .pagination-actions .btn {
    flex: 1;
    min-height: 40px;
  }
}
</style>
