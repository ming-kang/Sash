// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, nextTick, ref } from "vue";
import { vTooltip } from "./tooltip.js";

function host(template: string, setup: () => Record<string, unknown> = () => ({})) {
  return mount(defineComponent({ directives: { tooltip: vTooltip }, setup, template }), {
    attachTo: document.body,
  });
}

function tooltip(): HTMLElement | null {
  return document.querySelector(".sash-tooltip.visible");
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("v-tooltip", () => {
  it("names an element that has no text of its own", () => {
    const wrapper = host(`<button v-tooltip="'Refresh'"><svg /></button>`);
    expect(wrapper.get("button").attributes("aria-label")).toBe("Refresh");
  });

  it("leaves the visible text as the name of an element that has it", () => {
    const wrapper = host(`<button v-tooltip="'Restarts the Core'"><span>Apply</span></button>`);
    expect(wrapper.get("button").attributes("aria-label")).toBeUndefined();
  });

  it("keeps an explicit aria-label", () => {
    const wrapper = host(`<button aria-label="Stop Core" v-tooltip="'Stop'"><svg /></button>`);
    expect(wrapper.get("button").attributes("aria-label")).toBe("Stop Core");
  });

  it("follows the current text, including one that appears after mount", async () => {
    vi.useFakeTimers();
    const text = ref("");
    const wrapper = host(`<button v-tooltip="text"><svg /></button>`, () => ({ text }));
    const button = wrapper.get("button");
    expect(button.attributes("aria-label")).toBeUndefined();

    text.value = "Stopped";
    await nextTick();
    text.value = "Running · PID 42";
    await nextTick();
    expect(button.attributes("aria-label")).toBe("Running · PID 42");
    await button.trigger("pointerenter");
    await vi.runAllTimersAsync();
    expect(tooltip()?.textContent).toBe("Running · PID 42");

    text.value = "";
    await nextTick();
    expect(tooltip()).toBeNull();
    expect(button.attributes("aria-label")).toBeUndefined();
  });
});
