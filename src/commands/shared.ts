import type { RuntimeContext } from "../offline-mutation.js";
import { sashLayout } from "../paths.js";
import { loadSettings } from "../settings.js";

export type {
  OfflineMutationOptions,
  OfflineRuntimeReconciliation,
  RuntimeContext,
} from "../offline-mutation.js";
export { runOfflineMutation } from "../offline-mutation.js";

/** CLI entrypoint context: the user data directory plus its committed settings. */
export function runtimeContext(): RuntimeContext {
  const layout = sashLayout();
  const settings = loadSettings(layout);
  return { layout, settings };
}
