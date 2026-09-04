<template>
  <footer v-if="pages > 1" class="pagination-footer">
    <span class="pagination-summary">
      {{ t('common.pageSummary', { page, total: pages }) }}
    </span>
    <div class="pagination-actions">
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="page === 1"
        @click="page -= 1"
      >
        {{ t('common.previous') }}
      </button>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="page === pages"
        @click="page += 1"
      >
        {{ t('common.next') }}
      </button>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { t } from "../i18n/index.js";

const page = defineModel<number>("page", { required: true });

defineProps<{
  pages: number;
}>();
</script>

<style scoped>
.pagination-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 20px;
  border-top: 1px solid var(--border);
}
.pagination-summary {
  color: var(--text-muted);
  font-size: 14px;
}
.pagination-actions {
  display: flex;
  gap: 8px;
}

@media (max-width: 480px) {
  .pagination-footer {
    align-items: stretch;
    flex-direction: column;
  }
  .pagination-actions .btn {
    flex: 1;
  }
}
</style>
