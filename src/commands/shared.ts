import { loadSettings } from "../app-state.js";
import { sashLayout } from "../paths.js";
import type { RuntimeContext } from "../runtime-owner.js";

export type { RuntimeContext } from "../runtime-owner.js";

/** Read-only CLI context; only the daemon initializes or publishes application state. */
export function runtimeContext(): RuntimeContext {
  const layout = sashLayout();
  return { layout, settings: loadSettings(layout) };
}
