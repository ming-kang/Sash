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
            <td class="cell-mono text-muted idx">{{ entry.originalIndex + 1 }}</td>
            <td class="rule-type">
              <span class="badge badge-neutral">{{ entry.rule.type }}</span>
            </td>
            <td class="cell-mono rule-payload" :title="entry.rule.payload || '-'">
              {{ entry.rule.payload || '-' }}
            </td>
            <td class="rule-target">
              <span class="badge" :class="targetBadge(entry.rule.proxy)">{{ entry.rule.proxy }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState
        v-if="!isCoreRunning"
        icon="list-filter"
        :title="t('rules.coreStopped')"
        :hint="t('rules.coreStoppedHint')"
      />
      <EmptyState
        v-else-if="!store.resourceLoaded.rules"
        icon="loader"
        :title="t('common.loading')"
      />
      <EmptyState
        v-else-if="filteredRules.length === 0"
        icon="list-filter"
        :title="searchQuery.trim() ? t('rules.emptyMatch') : t('rules.empty')"
      />
    </div>

    <PaginationFooter v-model:page="currentPage" :pages="totalPages" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import PaginationFooter from "../components/PaginationFooter.vue";
import { t } from "../i18n/index.js";
import { isCoreRunning, store } from "../stores/index.js";

const PAGE_SIZE = 80;

function targetBadge(proxy: string): string {
  if (proxy.startsWith("REJECT")) return "badge-danger";
  if (proxy === "DIRECT") return "badge-neutral";
  return "badge-accent";
}

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
const pagedRules = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE;
  return filteredRules.value.slice(start, start + PAGE_SIZE);
});

watch(searchQuery, () => {
  currentPage.value = 1;
});
watch(
  () => store.rules,
  () => {
    currentPage.value = 1;
  },
);
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
  width: 280px;
}
.rule-list {
  border-radius: var(--radius-lg);
}
.data-table th,
.data-table td {
  padding-top: 9px;
  padding-bottom: 9px;
}
.idx {
  width: 64px;
}
.rule-type {
  width: 180px;
}
.rule-payload {
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rule-target {
  width: 28%;
}
.rule-target .badge {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
}

/* Phones: each rule becomes a two-line entry — type and index, then payload and target. */
@media (max-width: 760px) {
  :deep(.page-head-actions) {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .rule-search {
    width: min(260px, 100%);
    min-height: 40px;
  }
  .data-table thead {
    display: none;
  }
  .data-table,
  .data-table tbody {
    display: block;
  }
  .data-table tbody tr {
    display: grid;
    grid-template-areas:
      "type idx"
      "payload target";
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px 12px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  .data-table tbody tr:last-child {
    border-bottom: 0;
  }
  .data-table td {
    width: auto;
    max-width: none;
    padding: 0;
    border: 0;
  }
  .idx {
    grid-area: idx;
    font-size: 12px;
    text-align: right;
  }
  .rule-type {
    grid-area: type;
  }
  .rule-payload {
    grid-area: payload;
    font-size: 13px;
  }
  .rule-target {
    grid-area: target;
    justify-self: end;
  }
  .rule-target .badge {
    max-width: 55vw;
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
