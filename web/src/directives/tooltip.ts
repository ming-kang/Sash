import type { Directive } from "vue";

/**
 * v-tooltip — styled replacement for the native `title` attribute.
 *
 * One singleton `.sash-tooltip` node serves every trigger. Hovered/focused
 * elements reveal it after a short delay; consecutive triggers within
 * a cooldown window reveal instantly (Devin/base-ui tooltip-group behaviour).
 * Elements without an accessible name get the text as `aria-label`, matching
 * what the removed `title` used to provide.
 */

interface TooltipState {
  node: HTMLElement | null;
  owner: HTMLElement | null;
  timer: number;
  lastHide: number;
}

const SHOW_DELAY = 400;
const GROUP_WINDOW = 600;
const EDGE = 8;
const state: TooltipState = { node: null, owner: null, timer: 0, lastHide: 0 };

function tipNode(): HTMLElement {
  if (!state.node) {
    state.node = document.createElement("div");
    state.node.className = "sash-tooltip";
    state.node.setAttribute("role", "tooltip");
    document.body.appendChild(state.node);
  }
  return state.node;
}

function place(target: HTMLElement): void {
  const tip = tipNode();
  const rect = target.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const above = rect.top >= tipRect.height + EDGE + 4;
  const top = above ? rect.top - tipRect.height - 6 : rect.bottom + 6;
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.min(Math.max(left, EDGE), window.innerWidth - tipRect.width - EDGE);
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
  tip.dataset.side = above ? "top" : "bottom";
}

function show(target: HTMLElement, text: string): void {
  window.clearTimeout(state.timer);
  state.owner = target;
  const tip = tipNode();
  tip.textContent = text;
  tip.classList.remove("visible");
  place(target);
  state.timer = window.setTimeout(() => {
    if (state.owner !== target) return;
    tip.classList.add("visible");
  }, 16);
}

function schedule(target: HTMLElement, text: string): void {
  window.clearTimeout(state.timer);
  state.owner = target;
  const delay = performance.now() - state.lastHide < GROUP_WINDOW ? 0 : SHOW_DELAY;
  state.timer = window.setTimeout(() => show(target, text), delay);
}

function hide(target: HTMLElement): void {
  if (state.owner !== target) return;
  window.clearTimeout(state.timer);
  state.owner = null;
  state.lastHide = performance.now();
  state.node?.classList.remove("visible");
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type Decorated = HTMLElement & { __sashTip?: { open: () => void; close: () => void } };

export const vTooltip: Directive<Decorated, string> = {
  mounted(el, binding) {
    if (!textOf(binding.value)) return;
    if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby")) {
      el.setAttribute("aria-label", textOf(binding.value));
    }
    el.classList.add("has-tooltip");
    const open = () => {
      const text = textOf(binding.value);
      if (text) schedule(el, text);
    };
    const close = () => hide(el);
    el.__sashTip = { open, close };
    el.addEventListener("pointerenter", open);
    el.addEventListener("focusin", open);
    el.addEventListener("pointerleave", close);
    el.addEventListener("pointerdown", close);
    el.addEventListener("focusout", close);
  },
  updated(el, binding) {
    if (!textOf(binding.value)) hide(el);
    if (
      !el.hasAttribute("aria-label") &&
      !el.hasAttribute("aria-labelledby") &&
      textOf(binding.value)
    ) {
      el.setAttribute("aria-label", textOf(binding.value));
    }
  },
  unmounted(el) {
    hide(el);
    el.__sashTip = undefined;
  },
};
