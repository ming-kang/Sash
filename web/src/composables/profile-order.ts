import Sortable from "sortablejs";
import { computed, nextTick, onBeforeUnmount, onMounted, type Ref, ref, watch } from "vue";
import { t } from "../i18n/index.js";
import { errorText, reorderProfiles, toast } from "../stores/index.js";
import type { ProfileMeta } from "../types/index.js";

/** Keep Sortable's temporary DOM order separate from Vue and the committed index. */
export function useProfileOrder(
  grid: Ref<HTMLElement | null>,
  source: Readonly<Ref<ProfileMeta[]>>,
  disabled: Readonly<Ref<boolean>>,
) {
  const chosenId = ref<string | null>(null);
  const saving = ref(false);
  const preview = ref<readonly string[] | null>(null);
  let sortable: Sortable | undefined;
  let restoreBefore: ChildNode | null = null;
  let cancelled = false;
  let suppressClick = false;
  let disposed = false;

  const profiles = computed(() => {
    if (!preview.value) return source.value;
    const byId = new Map(source.value.map((profile) => [profile.id, profile]));
    const ordered = preview.value.flatMap((id) => {
      const profile = byId.get(id);
      return profile ? [profile] : [];
    });
    const included = new Set(preview.value);
    return [...ordered, ...source.value.filter((profile) => !included.has(profile.id))];
  });
  const busy = computed(() => chosenId.value !== null || saving.value);

  function cancelDrag(): void {
    if (!sortable || !Sortable.dragged || !sortable.el.contains(Sortable.dragged) || cancelled) {
      return;
    }
    cancelled = true;
    // Use the library's normal cancellation events so its ghost, timers and
    // document listeners are cleaned up for both pointer and touch backends.
    sortable.el.dispatchEvent(new Event("pointercancel", { bubbles: true }));
    sortable.el.dispatchEvent(new Event("touchcancel", { bubbles: true }));
  }

  async function saveOrder(ids: readonly string[], focusId: string): Promise<void> {
    if (disabled.value || saving.value) return;
    if (ids.every((id, index) => source.value[index]?.id === id)) return;
    preview.value = ids;
    saving.value = true;
    try {
      await reorderProfiles(ids);
      if (!disposed) toast.success(t("profiles.orderSaved"));
    } catch (error) {
      if (!disposed) toast.error(t("toast.failed", { msg: errorText(error) }));
    } finally {
      preview.value = null;
      saving.value = false;
      await nextTick();
      if (!disposed) {
        grid.value
          ?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusId)}"] .profile-card-main`)
          ?.focus({ preventScroll: true });
      }
    }
  }

  watch(
    grid,
    (element, _previous, onCleanup) => {
      if (!element) return;
      sortable = new Sortable(element, {
        draggable: ".profile-card",
        handle: ".profile-card-main",
        filter: ".profile-actions",
        preventOnFilter: false,
        disabled: disabled.value || saving.value,
        delay: 400,
        delayOnTouchOnly: false,
        touchStartThreshold: 6,
        fallbackTolerance: 3,
        forceFallback: true,
        fallbackOnBody: true,
        animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150,
        chosenClass: "profile-chosen",
        ghostClass: "profile-placeholder",
        fallbackClass: "profile-drag-ghost",
        onChoose: (event) => {
          cancelled = false;
          suppressClick = true;
          restoreBefore = event.item.nextSibling;
          chosenId.value = event.item.dataset.id ?? null;
        },
        onStart: () => {
          if (Sortable.ghost) {
            Sortable.ghost.inert = true;
            Sortable.ghost.setAttribute("aria-hidden", "true");
          }
        },
        onUnchoose: () => {
          chosenId.value = null;
        },
        onEnd: (event) => {
          const ids = sortable?.toArray() ?? [];
          // Restore the moved node before Vue applies the reactive order.
          // Keep Vue's trailing fragment anchor in place: Sortable.sort()
          // appends cards after that anchor and breaks later rollback renders.
          if (restoreBefore === null || restoreBefore.parentNode === event.from) {
            event.from.insertBefore(event.item, restoreBefore);
          }
          restoreBefore = null;
          const inputCancelled =
            "originalEvent" in event &&
            event.originalEvent instanceof Event &&
            event.originalEvent.type.endsWith("cancel");
          if (!cancelled && !inputCancelled && event.item.dataset.id) {
            void saveOrder(ids, event.item.dataset.id);
          }
        },
      });
      onCleanup(() => {
        cancelDrag();
        sortable?.destroy();
        sortable = undefined;
      });
    },
    { flush: "post" },
  );

  watch([disabled, saving], ([unavailable, pending]) => {
    if (unavailable || pending) cancelDrag();
    sortable?.option("disabled", unavailable || pending);
  });
  // Cancel before Vue patches a list changed by another tab or a background refresh.
  watch(() => source.value.map((profile) => profile.id).join(","), cancelDrag);

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && Sortable.dragged && grid.value?.contains(Sortable.dragged)) {
      event.preventDefault();
      cancelDrag();
    }
  }

  function onPointerdown(): void {
    // A drag's synthetic click may never arrive; a fresh gesture is always clickable.
    suppressClick = false;
    cancelled = false;
  }

  function onClick(event: MouseEvent): void {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick = false;
  }

  function moveWithKeyboard(event: KeyboardEvent, id: string): void {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    if (disabled.value || busy.value) return;
    const ids = source.value.map((profile) => profile.id);
    const from = ids.indexOf(id);
    const to = from + (event.key === "ArrowUp" ? -1 : 1);
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    void saveOrder(ids, id);
  }

  onMounted(() => {
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("blur", cancelDrag);
  });
  onBeforeUnmount(() => {
    disposed = true;
    cancelDrag();
    document.removeEventListener("keydown", onKeydown);
    window.removeEventListener("blur", cancelDrag);
  });

  return { profiles, chosenId, busy, onPointerdown, onClick, moveWithKeyboard };
}
