// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import Icon from "./Icon.vue";

describe("Icon", () => {
  it("renders the resolved icon as a decorative svg", () => {
    const wrapper = mount(Icon, { props: { name: "zap" } });
    const svg = wrapper.get("svg");
    expect(svg.attributes("aria-hidden")).toBe("true");
    expect(svg.attributes("focusable")).toBe("false");
  });

  it("normalizes a numeric size to pixels", () => {
    const wrapper = mount(Icon, { props: { name: "zap", size: 20 } });
    expect(wrapper.get("svg").attributes("width")).toBe("20px");
  });

  it("passes a string size through unchanged", () => {
    const wrapper = mount(Icon, { props: { name: "zap", size: "1.25em" } });
    expect(wrapper.get("svg").attributes("width")).toBe("1.25em");
  });

  it("still renders for an unknown name via the fallback icon", () => {
    const wrapper = mount(Icon, { props: { name: "no-such-icon" } });
    expect(wrapper.find("svg").exists()).toBe(true);
  });
});
