import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Window as HappyWindow } from "happy-dom";
import { ref } from "vue";

const globalKeys = [
  "window",
  "document",
  "navigator",
  "Node",
  "Text",
  "Comment",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
] as const;

async function withDom(run: (window: HappyWindow) => Promise<void>): Promise<void> {
  const window = new HappyWindow({ url: "http://127.0.0.1:19090/ui/" });
  const previous = new Map<string, { existed: boolean; value: unknown }>();
  for (const key of globalKeys) {
    previous.set(key, {
      existed: Object.hasOwn(globalThis, key),
      value: Reflect.get(globalThis, key),
    });
    Reflect.set(globalThis, key, Reflect.get(window, key));
  }
  try {
    await run(window);
  } finally {
    for (const [key, entry] of previous) {
      if (entry.existed) Reflect.set(globalThis, key, entry.value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function dialog(window: HappyWindow): {
  container: ReturnType<typeof ref<HTMLElement | null>>;
  button: HTMLElement;
} {
  const element = window.document.createElement("section");
  const button = window.document.createElement("button");
  button.textContent = "confirm";
  element.append(button);
  window.document.body.append(element);
  return {
    container: ref<HTMLElement | null>(element as unknown as HTMLElement),
    button: button as unknown as HTMLElement,
  };
}

describe("dialog focus and page scroll lock", () => {
  it("holds the lock while a nested dialog closes and restores overflow afterwards", async () => {
    await withDom(async (window) => {
      const { useDialogFocus } = await import("./useDialogFocus.js");
      window.document.body.style.overflow = "auto";
      window.document.documentElement.style.overflow = "scroll";
      const first = dialog(window);
      const second = dialog(window);
      const firstDialog = useDialogFocus({ container: first.container, onEscape: () => {} });
      const secondDialog = useDialogFocus({ container: second.container, onEscape: () => {} });

      await firstDialog.open();
      assert.equal(window.document.body.style.overflow, "hidden");
      assert.equal(window.document.documentElement.style.overflow, "hidden");
      assert.equal(window.document.activeElement, first.button);

      await secondDialog.open();
      assert.equal(window.document.body.style.overflow, "hidden");

      secondDialog.close();
      assert.equal(window.document.body.style.overflow, "hidden");

      firstDialog.close();
      assert.equal(window.document.body.style.overflow, "auto");
      assert.equal(window.document.documentElement.style.overflow, "scroll");
    });
  });

  it("delivers Escape to the topmost dialog only", async () => {
    await withDom(async (window) => {
      const { useDialogFocus } = await import("./useDialogFocus.js");
      const escapes: string[] = [];
      const first = dialog(window);
      const second = dialog(window);
      const firstDialog = useDialogFocus({
        container: first.container,
        onEscape: () => escapes.push("first"),
      });
      const secondDialog = useDialogFocus({
        container: second.container,
        onEscape: () => escapes.push("second"),
      });

      await firstDialog.open();
      await secondDialog.open();
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );
      assert.deepEqual(escapes, ["second"]);
      assert.equal(window.document.body.style.overflow, "hidden");

      secondDialog.close();
      await Promise.resolve();
      firstDialog.close();
      assert.equal(window.document.body.style.overflow, "");
    });
  });
});
