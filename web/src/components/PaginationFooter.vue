<template>
  <footer v-if="pages > 1" class="pagination-footer">
    <span class="pagination-summary">
      {{ t('common.pageSummary', { page, total: pages }) }}
    </span>
    <div class="pagination-actions">
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="page <= 1"
        @click="page = 1"
      >
        {{ t('common.firstPage') }}
      </button>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="page <= 1"
        @click="page -= 1"
      >
        {{ t('common.previous') }}
      </button>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="page >= pages"
        @click="page += 1"
      >
        {{ t('common.next') }}
      </button>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="page >= pages"
        @click="page = pages"
      >
        {{ t('common.lastPage') }}
      </button>
    </div>
    <form class="pagination-jump" @submit.prevent="jump">
      <input
        v-model="targetPage"
        class="input input-sm"
        type="number"
        inputmode="numeric"
        min="1"
        :max="pages"
        step="1"
        required
        :aria-label="t('common.pageNumber')"
      />
      <button type="submit" class="btn btn-secondary btn-sm">{{ t('common.jumpPage') }}</button>
    </form>
  </footer>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { t } from "../i18n/index.js";

const page = defineModel<number>("page", { required: true });

const props = defineProps<{
  pages: number;
}>();

const targetPage = ref<number | string>(page.value);
watch(page, (value) => { targetPage.value = value; });

function jump(): void {
  const target = Number(targetPage.value);
  if (Number.isInteger(target) && target >= 1 && target <= props.pages) page.value = target;
}
</script>

<style scoped>
.pagination-footer {
  display: flex;
  flex-wrap: wrap;
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
.pagination-jump {
  display: flex;
  gap: 8px;
}
.pagination-jump input {
  width: 80px;
}

@media (max-width: 480px) {
  .pagination-footer {
    align-items: stretch;
    flex-direction: column;
  }
  .pagination-actions .btn {
    flex: 1;
  }
  .pagination-jump {
    justify-content: flex-end;
  }
}
</style>
