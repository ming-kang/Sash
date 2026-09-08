<template>
  <div class="overview">
    <PageHeader :title="t('page.overview.title')" :desc="t('page.overview.desc')">
      <CoreControls />
    </PageHeader>

    <div class="overview-split">
      <OverviewGeneralPane />
      <OverviewProxyPane />
    </div>
  </div>
</template>

<script setup lang="ts">
import CoreControls from "../components/CoreControls.vue";
import OverviewGeneralPane from "../components/OverviewGeneralPane.vue";
import OverviewProxyPane from "../components/OverviewProxyPane.vue";
import PageHeader from "../components/PageHeader.vue";
import { t } from "../i18n/index.js";

</script>

<style scoped>
.overview {
  min-width: 0;
}
.overview-split {
  display: grid;
  grid-template-columns: minmax(300px, 0.92fr) minmax(0, 2fr);
  align-items: start;
  gap: clamp(18px, 2vw, 26px);
}

@media (min-width: 821px) {
  .overview {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
  }
  .overview-split {
    min-height: 0;
    flex: 1;
    align-items: start;
  }
  .overview-split > * {
    max-height: 100%;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
}

@media (max-width: 1120px) {
  .overview-split {
    grid-template-columns: minmax(280px, 0.9fr) minmax(0, 1.7fr);
    gap: 18px;
  }
}

@media (max-width: 820px) {
  .overview-split {
    grid-template-columns: 1fr;
  }
}
</style>
