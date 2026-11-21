import { type ComputedRef, computed } from "vue";
import {
  createMemoryHistory,
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
} from "vue-router";
import { asyncView } from "./components/async-view.js";

export const ROUTES = ["overview", "profiles", "logs", "connections", "rules"] as const;

export type Route = (typeof ROUTES)[number];

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: { name: "overview" } },
  {
    path: "/overview",
    name: "overview",
    component: asyncView(() => import("./views/OverviewView.vue")),
  },
  {
    path: "/profiles",
    name: "profiles",
    component: asyncView(() => import("./views/ProfilesView.vue")),
  },
  {
    path: "/logs",
    name: "logs",
    component: asyncView(() => import("./views/LogsView.vue")),
  },
  {
    path: "/connections",
    name: "connections",
    component: asyncView(() => import("./views/ConnectionsView.vue")),
  },
  {
    path: "/rules",
    name: "rules",
    component: asyncView(() => import("./views/RulesView.vue")),
  },
  // Unknown hashes land on the overview, matching the legacy hash parser.
  { path: "/:pathMatch(.*)*", redirect: { name: "overview" } },
];

// vue-router's hash history dereferences the bare `location` global; partial
// DOM harnesses provide `window` without it, so fall back to memory history.
export const router = createRouter({
  history:
    typeof window === "undefined" || typeof location === "undefined"
      ? createMemoryHistory()
      : createWebHashHistory(),
  routes,
});

function routeName(value: unknown): Route {
  return typeof value === "string" && (ROUTES as readonly string[]).includes(value)
    ? (value as Route)
    : "overview";
}

// The router owns navigation state; this narrows the current name to the
// pages the UI knows, defaulting to the overview for anything unmapped.
export const currentRoute: ComputedRef<Route> = computed(() =>
  routeName(router.currentRoute.value.name),
);

export function navigate(route: Route): void {
  if (currentRoute.value === route) return;
  void router.push({ name: route });
}
