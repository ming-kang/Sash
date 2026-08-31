import { ref } from "vue";

export const ROUTES = [
  "overview",
  "proxies",
  "connections",
  "rules",
  "subscription",
  "logs",
  "settings",
] as const;

export type Route = (typeof ROUTES)[number];

function parseHash(): Route {
  if (typeof window === "undefined") return "overview";
  const raw = window.location.hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  return (ROUTES as readonly string[]).includes(raw) ? (raw as Route) : "overview";
}

export const currentRoute = ref<Route>(parseHash());

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    currentRoute.value = parseHash();
  });
}

export function navigate(route: Route): void {
  if (currentRoute.value === route) return;
  window.location.hash = `/${route}`;
}
