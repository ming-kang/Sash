// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import UiSwitch from "./UiSwitch.vue";

describe("UiSwitch", () => {
  it("renders a switch button reflecting modelValue", () => {
    const wrapper = mount(UiSwitch, { props: { modelValue: false } });
    const button = wrapper.get("button");
    expect(button.attributes("role")).toBe("switch");
    expect(button.attributes("aria-checked")).toBe("false");
    expect(button.classes()).not.toContain("on");
  });

  it("marks the switch on when modelValue is true", () => {
    const wrapper = mount(UiSwitch, { props: { modelValue: true } });
    const button = wrapper.get("button");
    expect(button.attributes("aria-checked")).toBe("true");
    expect(button.classes()).toContain("on");
  });

  it("emits update:modelValue with the toggled value on click", async () => {
    const wrapper = mount(UiSwitch, { props: { modelValue: false } });
    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([[true]]);
  });

  it("uses the provided label and falls back to the localized default", () => {
    const labeled = mount(UiSwitch, { props: { modelValue: false, label: "Auto start" } });
    expect(labeled.get("button").attributes("aria-label")).toBe("Auto start");

    const unlabeled = mount(UiSwitch, { props: { modelValue: false } });
    expect(unlabeled.get("button").attributes("aria-label")).toBeTruthy();
  });

  it("does not emit while disabled", async () => {
    const wrapper = mount(UiSwitch, { props: { modelValue: false, disabled: true } });
    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });
});
