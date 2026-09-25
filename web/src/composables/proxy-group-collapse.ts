import { computed, type Ref, shallowRef } from "vue";

const STORAGE_KEY = "sash.proxy-group-collapse.v1";
const EXPANDED_GROUPS = 4;

export function useProxyGroupCollapse(groups: Ref<string[]>) {
  const preferences = shallowRef<Record<string, boolean>>({});
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved))
      preferences.value = Object.fromEntries(
        Object.entries(saved).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      );
  } catch {}

  const collapsedGroups = computed(
    () =>
      new Set(
        groups.value.filter((group, index) =>
          Object.hasOwn(preferences.value, group)
            ? preferences.value[group]
            : group !== "GLOBAL" && index >= EXPANDED_GROUPS,
        ),
      ),
  );

  function toggleCollapse(group: string): void {
    preferences.value = { ...preferences.value, [group]: !collapsedGroups.value.has(group) };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences.value));
    } catch {}
  }

  return { collapsedGroups, toggleCollapse };
}
