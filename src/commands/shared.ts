import { loadSettings } from "../app-state.js";
import type { RuntimeContext } from "../daemon-session.js";
import { sashLayout } from "../paths.js";

export type { RuntimeContext } from "../daemon-session.js";

/** Read-only CLI context; only the daemon initializes or publishes application state. */
export function runtimeContext(): RuntimeContext {
  const layout = sashLayout();
  return { layout, settings: loadSettings(layout) };
}
