import type { Ref } from "vue";
import { nextTick } from "vue";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

interface DialogEntry {
  container: () => HTMLElement | null;
  onEscape: () => void;
}

// Open dialogs stack; only the topmost one receives ESC/Tab handling so nested
// dialogs (ConfirmDialog over CodeEditorModal) do not both react to one keypress.
const stack: DialogEntry[] = [];
let listenerAttached = false;

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("hidden"),
  );
}

function onKeydown(event: KeyboardEvent): void {
  // Another handler (e.g. a CodeMirror keymap) already consumed this key.
  if (event.defaultPrevented) return;
  const top = stack[stack.length - 1];
  const root = top?.container();
  if (!top || !root) return;

  if (event.key === "Escape") {
    event.preventDefault();
    top.onEscape();
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = focusableElements(root);
  if (focusable.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === root || !root.contains(active))) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first?.focus();
  }
}

export interface DialogFocusOptions {
  container: Ref<HTMLElement | null>;
  initialFocus?: () => HTMLElement | null;
  onEscape: () => void;
}

export interface DialogFocusController {
  open(): Promise<void>;
  close(): void;
}

export function useDialogFocus(options: DialogFocusOptions): DialogFocusController {
  const entry: DialogEntry = {
    container: () => options.container.value,
    onEscape: options.onEscape,
  };
  let isOpen = false;
  let triggerElement: HTMLElement | null = null;

  async function open(): Promise<void> {
    if (isOpen || typeof window === "undefined") return;
    isOpen = true;
    triggerElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack.push(entry);
    if (!listenerAttached) {
      window.addEventListener("keydown", onKeydown);
      listenerAttached = true;
    }
    await nextTick();
    if (!isOpen) return;
    const root = options.container.value;
    const target = options.initialFocus?.() ?? (root ? focusableElements(root)[0] : null);
    (target ?? root)?.focus();
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    const index = stack.indexOf(entry);
    if (index !== -1) stack.splice(index, 1);
    if (stack.length === 0 && listenerAttached) {
      window.removeEventListener("keydown", onKeydown);
      listenerAttached = false;
    }
    const trigger = triggerElement;
    triggerElement = null;
    if (!trigger?.isConnected || typeof trigger.focus !== "function") return;
    void nextTick(() => {
      if (trigger.isConnected) trigger.focus({ preventScroll: true });
    });
  }

  return { open, close };
}
