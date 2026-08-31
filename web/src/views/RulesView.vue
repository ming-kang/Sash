<template>
  <div class="rules-view">
    <div class="header-bar">
      <div class="header-info">
        <h2 class="title-text">Routing Rules</h2>
        <span class="badge badge-neutral">{{ store.rules.length }} rules</span>
      </div>

      <div class="search-box">
        <Icon name="search" size="13" />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Filter rules..."
          class="search-input"
        />
      </div>
    </div>

    <!-- Rules Table -->
    <div class="data-table-wrap mt-4">
      <table class="data-table">
        <thead>
          <tr>
            <th class="w-16">#</th>
            <th>Type</th>
            <th>Match Payload</th>
            <th>Target Group</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="filteredRules.length === 0">
            <td colspan="4" class="text-center text-muted py-8">
              No rules match the filter
            </td>
          </tr>
          <tr v-for="(rule, idx) in filteredRules" :key="idx">
            <td class="cell-mono text-muted">#{{ idx + 1 }}</td>
            <td>
              <span class="badge badge-neutral">{{ rule.type }}</span>
            </td>
            <td class="cell-mono font-bold" :title="rule.payload || '-'">
              {{ rule.payload || '-' }}
            </td>
            <td>
              <span class="badge badge-primary">{{ rule.proxy }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import Icon from "../components/Icon.vue";
import { store } from "../stores/index.js";

const searchQuery = ref("");

const filteredRules = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return store.rules;
  return store.rules.filter(
    (r) =>
      r.type.toLowerCase().includes(q) ||
      r.payload.toLowerCase().includes(q) ||
      r.proxy.toLowerCase().includes(q),
  );
});
</script>

<style scoped>
.rules-view {
  display: flex;
  flex-direction: column;
}
.mt-4 {
  margin-top: 16px;
}
.w-16 {
  width: 60px;
}
.py-8 {
  padding-top: 32px;
  padding-bottom: 32px;
}
.text-center {
  text-align: center;
}

.header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.title-text {
  font-size: 18px;
  font-weight: 700;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-input);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-sm);
  padding: 5px 10px;
  width: 220px;
}

.search-input {
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  width: 100%;
}

.cell-mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.font-bold {
  font-weight: 600;
}
</style>
