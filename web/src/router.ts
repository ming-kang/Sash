import { ref } from "vue";

export const ROUTES = ["overview", "profiles", "logs", "connections", "rules", "settings"] as const;

export type Route = (typeof ROUTES)[number];

function parseHash(): Route {
  if (typeof window === "undefined") return "overview";
  let raw = window.location.hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  // Legacy hash from before the profiles redesign.
  if (raw === "subscription") raw = "profiles";
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
