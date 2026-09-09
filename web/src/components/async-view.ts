import { type Component, defineAsyncComponent } from "vue";
import AsyncViewState from "./AsyncViewState.vue";

export function asyncView(loader: () => Promise<{ default: Component }>) {
  return defineAsyncComponent({
    loader,
    loadingComponent: AsyncViewState,
    errorComponent: AsyncViewState,
    delay: 150,
    timeout: 20_000,
  });
}
