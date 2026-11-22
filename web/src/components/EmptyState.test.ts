// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import EmptyState from "./EmptyState.vue";

describe("EmptyState", () => {
  it("announces itself politely and renders the title", () => {
    const wrapper = mount(EmptyState, { props: { icon: "layers", title: "Nothing here" } });
    expect(wrapper.attributes("role")).toBe("status");
    expect(wrapper.get(".empty-title").text()).toBe("Nothing here");
  });

  it("renders the hint only when provided", () => {
    const withHint = mount(EmptyState, {
      props: { icon: "layers", title: "Empty", hint: "Add one to start" },
    });
    expect(withHint.get(".empty-hint").text()).toBe("Add one to start");

    const withoutHint = mount(EmptyState, { props: { icon: "layers", title: "Empty" } });
    expect(withoutHint.find(".empty-hint").exists()).toBe(false);
  });
});
