import type { Directive } from "vue";

/**
 * v-tooltip — styled replacement for the native `title` attribute.
 * One singleton node serves every trigger; consecutive triggers inside the
 * GROUP_WINDOW cooldown skip the show delay.
 */

interface TooltipState {
  node: HTMLElement | null;
  owner: HTMLElement | null;
  timer: number;
  lastHide: number;
}

interface Trigger {
  text: string;
  ownsLabel: boolean;
}

type Decorated = HTMLElement & { __sashTip?: Trigger };

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

function show(target: Decorated): void {
  window.clearTimeout(state.timer);
  const text = target.__sashTip?.text;
  if (!text) return;
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

function schedule(target: Decorated): void {
  window.clearTimeout(state.timer);
  state.owner = target;
  const delay = performance.now() - state.lastHide < GROUP_WINDOW ? 0 : SHOW_DELAY;
  state.timer = window.setTimeout(() => show(target), delay);
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

/** Text the element shows stays its name; the tooltip only names silent elements. */
function syncLabel(el: Decorated, trigger: Trigger): void {
  const named = el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby");
  if (named && !trigger.ownsLabel) return;
  const label = el.textContent?.trim() ? "" : trigger.text;
  if (label) el.setAttribute("aria-label", label);
  else if (trigger.ownsLabel) el.removeAttribute("aria-label");
  trigger.ownsLabel = Boolean(label);
}

function sync(el: Decorated, trigger: Trigger, value: unknown): void {
  const text = textOf(value);
  const changed = text !== trigger.text;
  trigger.text = text;
  el.classList.toggle("has-tooltip", Boolean(text));
  syncLabel(el, trigger);
  if (!text) hide(el);
  else if (changed && state.owner === el && state.node?.classList.contains("visible")) show(el);
}

export const vTooltip: Directive<Decorated, string> = {
  mounted(el, binding) {
    const trigger: Trigger = { text: "", ownsLabel: false };
    el.__sashTip = trigger;
    sync(el, trigger, binding.value);
    const open = () => {
      if (trigger.text) schedule(el);
    };
    const close = () => hide(el);
    el.addEventListener("pointerenter", open);
    el.addEventListener("focusin", open);
    el.addEventListener("pointerleave", close);
    el.addEventListener("pointerdown", close);
    el.addEventListener("focusout", close);
  },
  updated(el, binding) {
    if (el.__sashTip) sync(el, el.__sashTip, binding.value);
  },
  unmounted(el) {
    hide(el);
    el.__sashTip = undefined;
  },
};
