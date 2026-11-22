import { createApp } from "vue";
import App from "./App.vue";
import { vTooltip } from "./directives/tooltip.js";
import { i18n } from "./i18n/index.js";
import { router } from "./router.js";
import { pinia } from "./stores/state.js";
import "./styles/main.css";

createApp(App).use(pinia).use(router).use(i18n).directive("tooltip", vTooltip).mount("#app");
